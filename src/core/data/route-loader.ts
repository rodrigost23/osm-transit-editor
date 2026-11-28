import { type RouteSource, type Stop } from './geojson'
import { parseOsmJson, type OsmData, type OsmWay } from './osm-json'
import { type Entry, type Store, MemoryStore } from './store'
import { splitBox, tileBox, tilesCovering, type BoundingBox, type Tile } from './tiles'

// OpenStreetMap asks API clients to keep to two simultaneous requests.
// One request to the OSM API at a time. Queued requests start in the order they were asked for.
const CONCURRENCY = 1
// Only the tiles nearest the map centre are loaded, so panning is not met with a flood of requests.
// The tiles nearest the centre are loaded at once: the centre tile and its two nearest neighbours.
const NEAREST_TILES = 3
// Zoomed out, the cache is read for up to this many tiles nearest the centre. Reads are local, but a wide view has many tiles.
const CACHED_TILES = 64
const REQUEST_TIMEOUT_MS = 30_000
// Network errors and timeouts are retried with a growing delay, for up to this long.
const RETRY_WINDOW_MS = 60_000
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_DELAY_MS = 16_000
// After a rate limit or a server overload, requests wait at least this long, or Retry-After when longer.
// Each rate limit that comes soon after the last one doubles the wait, up to the maximum.
const MIN_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 15 * 60_000
const STREAK_WINDOW_MS = 10 * 60_000
// The cooldown is kept in local storage, so reloading the page does not send requests during it.
const COOLDOWN_KEY = 'osm-api-cooldown'
// A saved route is refreshed in the background this long after it is shown, so a burst of views does not refresh everything at once.
const REFRESH_DELAY_MS = 5_000
const COOLING_STATUS = new Set([429, 503, 509])
// A box the API refuses as too large is split into quarters, up to this many levels deeper.
const MAX_SPLIT_DEPTH = 4
// Saved data is always shown when it is there. Only data older than this is refreshed, once, when its area is opened.
const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Part of every cache key. Keep it stable: a change drops everything saved. Saved routes without stations are refreshed once instead.
const FORMAT_VERSION = 'v1'
// Cooldowns are waited out, and retried this many times at most. They do not count against the retry window.
const MAX_COOLING_RETRIES = 2

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

/** The part of local storage the cooldown uses. */
export type CooldownStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface LoaderOptions {
  fetchFn?: Fetch
  store?: Store
  now?: () => number
  sleep?: Sleep
  storage?: CooldownStorage
  /** Called when a cooldown starts, with the time (ms since epoch) it ends. */
  onCooldown?: (until: number) => void
  /** Overpass mirrors, in order of preference. Used only when the OSM API cannot answer. */
  overpassUrls?: string[]
}

interface Cooldown {
  until: number
  streak: number
}

/** Local storage when the browser gives it, otherwise none: the cooldown then lasts for this page only. */
function defaultStorage(): CooldownStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
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
  // The way each line comes from, in the same order, so routes of one line can share a way.
  const ways: number[] = []
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
    if (line.length > 1) {
      lines.push(line)
      ways.push(member.ref)
    }
  }
  return { id, tags: relation.tags, lines, ways, stops }
}

export function mapUrl(apiUrl: string, box: BoundingBox): string {
  // The API takes the bounds as left, bottom, right, top.
  const bbox = [box.west, box.south, box.east, box.north].join(',')
  return `${apiUrl}/api/0.6/map.json?bbox=${bbox}`
}

export function relationFullUrl(apiUrl: string, id: number): string {
  return `${apiUrl}/api/0.6/relation/${id}/full.json`
}

/** Overpass query for the subway relations in a box. Same answer as the map call, in Overpass JSON. */
export function overpassMapQuery(box: BoundingBox): string {
  // Overpass takes the bounds as south, west, north, east.
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:25];relation["route"="subway"](${bbox});out body;`
}

/** Overpass query for one route relation with its ways and nodes. Same answer as the full call. */
export function overpassRelationQuery(id: number): string {
  return `[out:json][timeout:25];relation(${id});(._;>;);out body;`
}

/** GET URL for an Overpass mirror. A plain GET needs no CORS preflight. */
export function overpassUrl(mirror: string, query: string): string {
  return `${mirror}?data=${encodeURIComponent(query)}`
}

// Errors from the OSM API that send the request on to a mirror. Cooldowns (429, 503, 509) do not:
// they mean the OSM API asked us to wait, and a mirror answer would not change that.
function fallsBackToMirror(error: unknown): boolean {
  if (error instanceof TransportError) return true
  return error instanceof OsmHttpError && error.status >= 500 && !COOLING_STATUS.has(error.status)
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

export interface LoadOptions {
  /** Ask the API again for the box and its routes, even when they are saved. */
  refresh?: boolean
  /**
   * Ask the Overpass mirrors first, with one query for the whole box. Used at zoom levels
   * below the OSM API's line zoom, where its tile-sized requests would be too many.
   */
  overpassFirst?: boolean
}

/** A saved route from before stations and way ids were kept. It is refreshed once, so both appear. */
function outdatedRoute(value: unknown): boolean {
  return !('stops' in (value as object)) || !('ways' in (value as object))
}

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
  private readonly storage: CooldownStorage | undefined
  private readonly onCooldown: ((until: number) => void) | undefined
  private readonly overpassUrls: string[]
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly refreshing = new Set<string>()
  private pausedUntil = 0

  constructor(apiUrl: string, options: LoaderOptions = {}) {
    this.apiUrl = apiUrl
    // Wrapped: a bare fetch stored on this object and called as a method throws "Illegal invocation" in browsers.
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.store = options.store ?? new MemoryStore(300)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
    this.storage = options.storage ?? defaultStorage()
    this.onCooldown = options.onCooldown
    this.overpassUrls = options.overpassUrls ?? []
    this.pausedUntil = this.readCooldown()?.until ?? 0
  }

  /** Milliseconds until requests are sent again after a rate limit or overload. Zero when none is in force. */
  cooldownLeft(): number {
    return Math.max(0, this.pausedUntil - this.now())
  }

  /** Loads the routes crossing the box. onUpdate is called each time more of them are ready. */
  async load(
    box: BoundingBox,
    signal: AbortSignal,
    onUpdate?: (result: LoadResult) => void,
    options: LoadOptions = {},
  ): Promise<LoadResult> {
    if (options.overpassFirst && this.overpassUrls.length > 0) {
      return this.loadFromMirrors(box, signal, onUpdate, options.refresh)
    }
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
        promise = this.remember(`route/${FORMAT_VERSION}/${id}`, signal, (s) => this.fetchRoute(id, s), {
          force: options.refresh,
          outdated: outdatedRoute,
        })
        pending.set(id, promise)
      }
      return promise
    }

    await Promise.all(
      quarters.map(async (quarter) => {
        let ids: number[]
        try {
          ids = await this.remember(quarter.key, signal, (s) => this.fetchQuarter(quarter.box, s, 0), { force: options.refresh })
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

  /**
   * The routes already in the store for the box, whatever their age, without any request. Used
   * where the map does not load lines, so that routes saved earlier show as soon as the map opens.
   */
  async cached(box: BoundingBox, signal: AbortSignal): Promise<RouteSource[]> {
    const centre = centreOf(box)
    const tiles = tilesCovering(box)
      .sort((a, b) => distance(centreOf(tileBox(a)), centre) - distance(centreOf(tileBox(b)), centre))
      .slice(0, CACHED_TILES)
    const ids = new Set<number>()
    await Promise.all(
      tiles.flatMap((tile) =>
        splitBox(tileBox(tile)).map(async (_, index) => {
          const saved = await this.store.get(`${FORMAT_VERSION}/${tileKey(tile)}/${index}`)
          for (const id of (saved?.value as number[] | undefined) ?? []) ids.add(id)
        }),
      ),
    )
    throwIfCancelled(signal)
    const saved = await Promise.all([...ids].map((id) => this.store.get(`route/${FORMAT_VERSION}/${id}`)))
    throwIfCancelled(signal)
    return saved.flatMap((entry) => (entry ? [entry.value as RouteSource] : []))
  }

  /** Answers from the store when it can, and saves what it fetched when it succeeds. */
  private async remember<T>(
    key: string,
    signal: AbortSignal,
    load: (signal: AbortSignal) => Promise<T>,
    options: { force?: boolean; outdated?: (value: unknown) => boolean } = {},
  ): Promise<T> {
    const saved = options.force ? undefined : await this.store.get(key)
    if (saved) {
      // Shown as it is. The background refresh only runs for old data, never for data that is merely cached.
      if (this.now() - saved.savedAt >= STALE_MS || options.outdated?.(saved.value)) void this.refresh(key, load)
      return saved.value as T
    }
    const value = await load(signal)
    this.save(key, value)
    return value
  }

  private async refresh<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<void> {
    // One refresh per key at a time: the older copy is still stale after a view, so later views would ask again.
    if (this.refreshing.has(key)) return
    this.refreshing.add(key)
    try {
      await this.sleep(REFRESH_DELAY_MS, new AbortController().signal)
      this.save(key, await load(new AbortController().signal))
    } catch {
      // The older copy stays in the store until a later load succeeds.
    } finally {
      this.refreshing.delete(key)
    }
  }

  private save(key: string, value: unknown): void {
    const entry: Entry = { value, savedAt: this.now() }
    void this.store.set(key, entry).catch(() => undefined)
  }

  private async fetchQuarter(box: BoundingBox, signal: AbortSignal, depth: number): Promise<number[]> {
    try {
      return subwayRouteIds(parseOsmJson(await this.requestOrMirror(mapUrl(this.apiUrl, box), overpassMapQuery(box), signal)))
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
    const text = await this.requestOrMirror(relationFullUrl(this.apiUrl, id), overpassRelationQuery(id), signal)
    return relationRoute(parseOsmJson(text), id)
  }

  /**
   * Loads the box from the Overpass mirrors: one query for the subway relations in the box,
   * then one per route. Nothing is kept in the store, so these results are always fresh.
   */
  private async loadFromMirrors(
    box: BoundingBox,
    signal: AbortSignal,
    onUpdate?: (result: LoadResult) => void,
    refresh = false,
  ): Promise<LoadResult> {
    const routes = new Map<number, RouteSource>()
    const failures: LoadFailure[] = []
    const mirrorFailure = new TransportError('Overpass first')
    // The z14 quarters wholly inside the box are saved under the same keys the OSM path uses.
    // When every one of them is saved, the box is answered from the store and no query is sent.
    const inside = tilesCovering(box).flatMap((tile) =>
      splitBox(tileBox(tile))
        .map((part, index) => ({ key: `${FORMAT_VERSION}/${tileKey(tile)}/${index}`, part }))
        .filter(({ part }) => within(part, box)),
    )
    let ids: number[] | undefined
    if (!refresh && inside.length > 0) {
      const saved = await Promise.all(inside.map(({ key }) => this.store.get(key)))
      if (saved.every((entry) => entry !== undefined)) {
        ids = [...new Set(saved.flatMap((entry) => (entry?.value as number[] | undefined) ?? []))]
      }
    }
    if (ids === undefined) {
      try {
        const text = await this.fromMirrors(overpassMapQuery(box), signal, mirrorFailure)
        ids = subwayRouteIds(parseOsmJson(text))
      } catch (error) {
        if (signal.aborted) throw cancelled()
        failures.push({ kind: 'map', url: this.overpassUrls[0], reason: describeError(error) })
        return { routes: [], failures }
      }
      // The query covered each quarter entirely, so its routes are the ones the quarter needs.
      for (const { key } of inside) this.save(key, ids)
    }
    const found = ids
    await Promise.all(
      found.map(async (id) => {
        try {
          routes.set(
            id,
            await this.remember(`route/${FORMAT_VERSION}/${id}`, signal, async (s) => {
              const text = await this.fromMirrors(overpassRelationQuery(id), s, mirrorFailure)
              return relationRoute(parseOsmJson(text), id)
            }, { force: refresh, outdated: outdatedRoute }),
          )
        } catch (error) {
          if (!signal.aborted) failures.push({ kind: 'relation', url: this.overpassUrls[0], reason: describeError(error) })
        }
        if (!signal.aborted && onUpdate) onUpdate({ routes: [...routes.values()], failures: [...failures] })
      }),
    )
    throwIfCancelled(signal)
    return { routes: [...routes.values()], failures }
  }

  /** The OSM API first. If it cannot answer, the Overpass mirrors are tried in order. */
  private async requestOrMirror(url: string, query: string, signal: AbortSignal): Promise<string> {
    try {
      return await this.request(url, signal)
    } catch (error) {
      if (signal.aborted || this.overpassUrls.length === 0 || !fallsBackToMirror(error)) throw error
      return this.fromMirrors(query, signal, error)
    }
  }

  /** Tries each mirror once per request. Mirror cooldowns do not pause the OSM API. Throws the OSM error if all fail. */
  private async fromMirrors(query: string, signal: AbortSignal, osmError: unknown): Promise<string> {
    for (const mirror of this.overpassUrls) {
      try {
        return await this.limited(signal, () => this.once(overpassUrl(mirror, query), signal, true))
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
    throw osmError
  }

  /** A GET with a timeout. Network errors and timeouts are retried; other HTTP errors are not. */
  private async request(url: string, signal: AbortSignal): Promise<string> {
    const started = this.now()
    let delay = FIRST_RETRY_MS
    let coolings = 0
    for (;;) {
      try {
        return await this.limited(signal, () => this.once(url, signal))
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof OsmHttpError && COOLING_STATUS.has(error.status)) {
          // The cooldown already says how long to wait, so the next attempt just queues behind it.
          if (++coolings > MAX_COOLING_RETRIES) throw error
          continue
        }
        if (!(error instanceof TransportError) || this.now() - started + delay > RETRY_WINDOW_MS) throw error
        await this.sleep(delay, signal)
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
      }
    }
  }

  private async once(url: string, signal: AbortSignal, mirror = false): Promise<string> {
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
        if (!mirror && COOLING_STATUS.has(response.status)) this.cool(retryAfterMs(response))
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

  /** Starts a cooldown after a rate limit or overload. Requests made meanwhile wait for it, and it survives a reload. */
  private cool(retryAfter: number): void {
    const now = this.now()
    const previous = this.readCooldown()
    // Requests that fail together start one cooldown, not one each. Only a new rate limit after the last one escalates it.
    if (previous && now < previous.until) return
    const streak = previous && now - previous.until < STREAK_WINDOW_MS ? previous.streak + 1 : 1
    const ms = Math.min(Math.max(retryAfter, MIN_COOLDOWN_MS) * 2 ** (streak - 1), MAX_COOLDOWN_MS)
    const until = now + ms
    this.pausedUntil = Math.max(this.pausedUntil, until)
    this.writeCooldown({ until, streak })
    this.onCooldown?.(until)
  }

  private readCooldown(): Cooldown | undefined {
    try {
      const raw = this.storage?.getItem(COOLDOWN_KEY)
      if (!raw) return undefined
      const value = JSON.parse(raw) as Partial<Cooldown>
      return Number.isFinite(value.until) && Number.isFinite(value.streak) ? (value as Cooldown) : undefined
    } catch {
      return undefined
    }
  }

  private writeCooldown(cooldown: Cooldown): void {
    try {
      this.storage?.setItem(COOLDOWN_KEY, JSON.stringify(cooldown))
    } catch {
      // Storage is full or blocked: the cooldown still applies to this page.
    }
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

/** True when a lies wholly inside b. */
function within(a: BoundingBox, b: BoundingBox): boolean {
  return a.west >= b.west && a.east <= b.east && a.south >= b.south && a.north <= b.north
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
