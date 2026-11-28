import { type RouteSource, type Stop } from './geojson'
import { parseOsmJson, type OsmData, type OsmWay } from './osm-json'
import { type Entry, type Store, MemoryStore } from './store'
import { splitBox, tileBox, tilesCovering, type BoundingBox, type Tile } from './tiles'

// OpenStreetMap asks API clients to keep to two simultaneous requests.
const CONCURRENCY = 2
// Only the tiles nearest the map centre are loaded, so panning is not met with a flood of requests.
const NEAREST_TILES = 6
const REQUEST_TIMEOUT_MS = 30_000
// Network errors and timeouts are retried with a growing delay, for up to this long.
const RETRY_WINDOW_MS = 60_000
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_DELAY_MS = 16_000
// After a rate limit or a server overload, requests wait this long, or Retry-After when given.
const COOLDOWN_MS = 30_000
const COOLING_STATUS = new Set([429, 503, 509])
// A box the API refuses as too large is split into quarters, up to this many levels deeper.
const MAX_SPLIT_DEPTH = 4
// Saved data younger than this is used as is. Older data is shown at once and refreshed in the background.
const FRESH_MS = 24 * 60 * 60 * 1000
// Part of every cache key. Change it when the saved shape changes.
const FORMAT_VERSION = 'v3'

export class OsmHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/** No response, or no answer in time. These are retried. */
export class TransportError extends Error {}

/** A request that did not give a route. The rest of the view still loads. */
export interface LoadFailure {
  kind: 'map' | 'relation'
  url: string
  reason: string
}

export interface LoadResult {
  routes: RouteSource[]
  failures: LoadFailure[]
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

export interface LoaderOptions {
  fetchFn?: Fetch
  store?: Store
  now?: () => number
  sleep?: Sleep
}

/** Text that says why a request failed, for the console and the notice on the map. */
export function describeError(error: unknown): string {
  if (error instanceof OsmHttpError) {
    if (error.status === 429) return 'HTTP 429 (rate limited)'
    if (error.status === 509) return 'HTTP 509 (bandwidth limit)'
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** Subway relation ids in a map response. */
export function subwayRouteIds(data: OsmData): number[] {
  return [...data.relations]
    .filter(([, relation]) => relation.tags.route === 'subway')
    .map(([id]) => id)
}

// Member roles that are the track itself. Platforms, stops and entrances have other roles.
const TRACK_ROLES = new Set(['', 'forward', 'backward'])

/** True for a way that is track. Platforms and areas drawn as ways are left out. */
function isTrack(way: OsmWay): boolean {
  const { railway, public_transport: publicTransport, highway, area } = way.tags
  return railway !== 'platform' && publicTransport !== 'platform' && highway !== 'platform' && area !== 'yes'
}

/** Member roles of stop nodes. Platforms and station entrances are not stops and are not drawn. */
const STOP_ROLES = new Set(['stop', 'stop_entry_only', 'stop_exit_only'])

/** Builds a route from a relation's track ways and its stop nodes. Ways outside the requested area are included. */
export function relationRoute(data: OsmData, id: number): RouteSource {
  const relation = data.relations.get(id)
  if (!relation) throw new Error(`Relation ${id} is missing from the response`)
  const lines: [number, number][][] = []
  const stops: Stop[] = []
  for (const member of relation.members) {
    if (member.type === 'node' && STOP_ROLES.has(member.role)) {
      const node = data.nodes.get(member.ref)
      if (node && Number.isFinite(node.lat) && Number.isFinite(node.lon)) {
        stops.push({ key: `n${member.ref}`, name: node.tags?.name ?? '', lat: node.lat, lon: node.lon })
      }
      continue
    }
    if (member.type !== 'way' || !TRACK_ROLES.has(member.role)) continue
    const way = data.ways.get(member.ref)
    if (!way || !isTrack(way)) continue
    const line: [number, number][] = []
    for (const ref of way.nodes) {
      const node = data.nodes.get(ref)
      if (node) line.push([node.lon, node.lat])
    }
    if (line.length > 1) lines.push(line)
  }
  return { id, tags: relation.tags, lines, stops }
}

export function mapUrl(apiUrl: string, box: BoundingBox): string {
  // The API takes the bounds as left, bottom, right, top.
  const bbox = [box.west, box.south, box.east, box.north].join(',')
  return `${apiUrl}/api/0.6/map.json?bbox=${bbox}`
}

export function relationFullUrl(apiUrl: string, id: number): string {
  return `${apiUrl}/api/0.6/relation/${id}/full.json`
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Loads subway routes for the visible area. Each tile is split into quarters, and the
 * quarters nearest the centre are asked for first. The map is redrawn as each quarter
 * arrives. A failing request is reported, and the rest still loads.
 *
 * Results are kept in a store: fresh results are used as they are, older ones are shown
 * at once and refreshed in the background. Failed or partial results are never kept.
 */
export class RouteLoader {
  private readonly apiUrl: string
  private readonly fetchFn: Fetch
  private readonly store: Store
  private readonly now: () => number
  private readonly sleep: Sleep
  private active = 0
  private readonly waiting: (() => void)[] = []
  private pausedUntil = 0

  constructor(apiUrl: string, options: LoaderOptions = {}) {
    this.apiUrl = apiUrl
    // Wrapped: a bare fetch stored on this object and called as a method throws "Illegal invocation" in browsers.
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.store = options.store ?? new MemoryStore(300)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
  }

  /** Loads the routes crossing the box. onUpdate is called each time more of them are ready. */
  async load(box: BoundingBox, signal: AbortSignal, onUpdate?: (result: LoadResult) => void): Promise<LoadResult> {
    const centre = centreOf(box)
    const tiles = tilesCovering(box)
      .sort((a, b) => distance(centreOf(tileBox(a)), centre) - distance(centreOf(tileBox(b)), centre))
      .slice(0, NEAREST_TILES)
    const quarters = tiles
      .flatMap((tile) => splitBox(tileBox(tile)).map((part, index) => ({ key: `${FORMAT_VERSION}/${tileKey(tile)}/${index}`, box: part })))
      .sort((a, b) => distance(centreOf(a.box), centre) - distance(centreOf(b.box), centre))

    const routes = new Map<number, RouteSource>()
    const failures: LoadFailure[] = []
    const reported = new Set<string>()
    const pending = new Map<number, Promise<RouteSource>>()
    const report = (failure: LoadFailure) => {
      if (reported.has(failure.url)) return
      reported.add(failure.url)
      failures.push(failure)
    }
    // A route shared by several quarters is asked for once.
    const routeFor = (id: number): Promise<RouteSource> => {
      let promise = pending.get(id)
      if (!promise) {
        promise = this.remember(`route/${FORMAT_VERSION}/${id}`, signal, (s) => this.fetchRoute(id, s))
        pending.set(id, promise)
      }
      return promise
    }

    await Promise.all(
      quarters.map(async (quarter) => {
        let ids: number[]
        try {
          ids = await this.remember(quarter.key, signal, (s) => this.fetchQuarter(quarter.box, s, 0))
        } catch (error) {
          if (!signal.aborted) report({ kind: 'map', url: mapUrl(this.apiUrl, quarter.box), reason: describeError(error) })
          return
        }
        await Promise.all(
          ids.map(async (id) => {
            try {
              routes.set(id, await routeFor(id))
            } catch (error) {
              if (!signal.aborted) report({ kind: 'relation', url: relationFullUrl(this.apiUrl, id), reason: describeError(error) })
            }
          }),
        )
        if (!signal.aborted && onUpdate) onUpdate({ routes: [...routes.values()], failures: [...failures] })
      }),
    )
    throwIfCancelled(signal)
    return { routes: [...routes.values()], failures }
  }

  /** Answers from the store when it can, and saves what it fetched when it succeeds. */
  private async remember<T>(key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const saved = await this.store.get(key)
    if (saved && this.now() - saved.savedAt < FRESH_MS) return saved.value as T
    if (saved) {
      void this.refresh(key, load)
      return saved.value as T
    }
    const value = await load(signal)
    this.save(key, value)
    return value
  }

  private async refresh<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<void> {
    try {
      this.save(key, await load(new AbortController().signal))
    } catch {
      // The older copy stays in the store until a later load succeeds.
    }
  }

  private save(key: string, value: unknown): void {
    const entry: Entry = { value, savedAt: this.now() }
    void this.store.set(key, entry).catch(() => undefined)
  }

  private async fetchQuarter(box: BoundingBox, signal: AbortSignal, depth: number): Promise<number[]> {
    try {
      return subwayRouteIds(parseOsmJson(await this.request(mapUrl(this.apiUrl, box), signal)))
    } catch (error) {
      // 400 from the map call means the box holds too much data. Split it and ask for the parts.
      if (error instanceof OsmHttpError && error.status === 400 && depth < MAX_SPLIT_DEPTH) {
        const ids = new Set<number>()
        for (const part of splitBox(box)) {
          for (const id of await this.fetchQuarter(part, signal, depth + 1)) ids.add(id)
        }
        return [...ids]
      }
      throw error
    }
  }

  private async fetchRoute(id: number, signal: AbortSignal): Promise<RouteSource> {
    const text = await this.request(relationFullUrl(this.apiUrl, id), signal)
    return relationRoute(parseOsmJson(text), id)
  }

  /** A GET with a timeout. Network errors and timeouts are retried; other HTTP errors are not. */
  private async request(url: string, signal: AbortSignal): Promise<string> {
    const started = this.now()
    let delay = FIRST_RETRY_MS
    for (;;) {
      try {
        return await this.limited(signal, () => this.once(url, signal))
      } catch (error) {
        const retryable = error instanceof TransportError || (error instanceof OsmHttpError && COOLING_STATUS.has(error.status))
        if (!retryable || signal.aborted || this.now() - started + delay > RETRY_WINDOW_MS) throw error
        await this.sleep(delay, signal)
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
      }
    }
  }

  private async once(url: string, signal: AbortSignal): Promise<string> {
    // A plain GET with no custom headers, so the browser needs no CORS preflight.
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchFn(url, { signal: controller.signal })
      if (!response.ok) {
        if (COOLING_STATUS.has(response.status)) this.cool(retryAfterMs(response) || COOLDOWN_MS)
        throw new OsmHttpError(response.status)
      }
      return await response.text()
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (timedOut) throw new TransportError(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`)
      if (error instanceof OsmHttpError) throw error
      // fetch() rejects with a TypeError when no response arrives: offline, blocked, or CORS.
      // Log the real message so a failure before the request is sent is not mistaken for a network problem.
      if (error instanceof TypeError) {
        console.error('[osm] fetch rejected', {
          url,
          name: error.name,
          message: error.message,
          stack: error.stack,
          online: globalThis.navigator?.onLine,
          page: globalThis.location?.href,
        })
        throw new TransportError(`network error: ${error.message}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  }

  private cool(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms)
  }

  /** Runs a request once a slot is free and any cooldown is over. A slot passes straight to the next waiting request. */
  private async limited<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.active < CONCURRENCY) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      for (let wait = this.pausedUntil - this.now(); wait > 0; wait = this.pausedUntil - this.now()) {
        await this.sleep(wait, signal)
      }
      throwIfCancelled(signal)
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

/** Seconds from Retry-After, in milliseconds. Browsers only expose the header when the server allows it. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

function cancelled(): DOMException {
  return new DOMException('Request cancelled', 'AbortError')
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

function centreOf(box: BoundingBox): { lat: number; lon: number } {
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 }
}

/** Squared distance in degrees. Only used to put things in order, so the projection does not matter. */
function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return (a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2
}

function tileKey({ x, y, z }: Tile): string {
  return `${z}/${x}/${y}`
}
