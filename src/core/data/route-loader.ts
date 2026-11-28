import { type RouteMaster, type RouteSource, type Stop } from './geojson'
import { parseOsmJson, type OsmData, type OsmWay } from './osm-json'
import { areaOf, cellOf, intersects, segmentIndex, tilesIn, type Cell, type Segment } from './coverage'
import { type Entry, type Store, MemoryStore } from './store'
import { splitBox, tileBox, type BoundingBox, type Tile } from './tiles'

// OpenStreetMap asks API clients to keep to two simultaneous requests.
// One request to the OSM API at a time. Queued requests start in the order they were asked for.
const CONCURRENCY = 1
// Only the tiles nearest the map centre are loaded at once, so panning is not met with a flood of requests.
const NEAREST_TILES = 3
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
// Saved data is refreshed in the background this long after it is shown, so a burst of views does not refresh everything at once.
const REFRESH_DELAY_MS = 5_000
const COOLING_STATUS = new Set([429, 503, 509])
// A box the API refuses as too large is split into quarters, up to this many levels deeper.
const MAX_SPLIT_DEPTH = 4
// Saved data is always shown when it is there. Only data older than this is refreshed in the background.
const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Cooldowns are waited out, and retried this many times at most. They do not count against the retry window.
const MAX_COOLING_RETRIES = 2
/** Saved routes and coverage may take this many bytes. The least recently used are removed beyond it. */
export const DEFAULT_BUDGET_BYTES = 40 * 1024 * 1024
// Format of the saved data. Version 1 (one entry per quarter of a tile) is read once, moved, and removed.
// Version 3 stores the route_master of each route, so version 2 routes are fetched again.
const FORMAT = 'v3'
const INDEX_KEY = `index/${FORMAT}`
const ROUTE_PREFIX = `route/${FORMAT}/`
const CELL_PREFIX = `cell/${FORMAT}/`
const MASTER_PREFIX = `master/${FORMAT}/`
const LEGACY_ROUTE_PREFIX = 'route/v1/'
const LEGACY_TILE_PREFIX = 'v1/'
const TILE_ZOOM = 14

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
  /** Size limit for saved routes and coverage. Defaults to DEFAULT_BUDGET_BYTES. */
  budgetBytes?: number
}

interface Cooldown {
  until: number
  streak: number
}

interface RouteMeta {
  bytes: number
  used: number
  box?: BoundingBox
}

interface CellMeta {
  bytes: number
  used: number
}

/** What is saved beside the data: how big each entry is and when it was last used. Kept in memory and saved as one entry. */
interface Index {
  routes: Record<string, RouteMeta>
  cells: Record<string, CellMeta>
  migrated?: boolean
}

interface LoadedCell {
  cell: Cell
  at: Map<number, Segment>
}

/** Routes asked for during one load. A refresh asks the API once per route, not once per view of the tiles. */
interface LoadContext {
  refresh: boolean
  done: Set<number>
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

/** The box that holds every line of a route, or nothing when it has no lines. */
function routeBox(route: RouteSource): BoundingBox | undefined {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const line of route.lines) {
    for (const [lon, lat] of line) {
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : undefined
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

/** Overpass query for the IDs of the subway relations in a box. The details come from the OSM API. */
export function overpassRouteIdsQuery(box: BoundingBox): string {
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:25];relation["route"="subway"](${bbox});out ids;`
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
   * Ask the Overpass mirrors first, with one query for the missing part of the box. Used at zoom levels
   * below the OSM API's line zoom, where its tile-sized requests would be too many.
   */
  overpassFirst?: boolean
}

/** A saved route from before stations and way ids were kept. It is refreshed once, so both appear. */
function outdatedRoute(value: unknown): boolean {
  return !('stops' in (value as object)) || !('ways' in (value as object))
}

function isRoute(value: unknown): value is RouteSource {
  return typeof value === 'object' && value !== null && Array.isArray((value as RouteSource).lines)
}

/** Tiles nearest a centre first. */
function byDistance(centre: { lat: number; lon: number }) {
  return (a: Tile, b: Tile) => distance(centreOf(tileBox(a)), centre) - distance(centreOf(tileBox(b)), centre)
}

/**
 * Loads subway routes for the visible area, and keeps what it fetched.
 *
 * What is kept: each route once, with the box it covers; and, per tile, which
 * requests covered it and which route IDs they found. A view asks only for the tiles
 * it does not cover yet, so going back to an area needs no request, whatever the zoom.
 * The least recently used data is removed when the size limit is reached.
 *
 * Fresh data is used as it is. Older data is shown at once and refreshed in the
 * background. Failed or partial requests are never kept.
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
  private readonly budgetBytes: number
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly refreshing = new Set<string>()
  private readonly inflight = new Map<number, Promise<RouteSource>>()
  private pausedUntil = 0
  private index: Index | undefined
  private opened: Promise<Index> | undefined
  private indexDirty = false
  private readonly cells = new Map<string, LoadedCell>()
  // Writes to routes and coverage run one after another, so a read-modify-write of one cell cannot interleave.
  private chain: Promise<void> = Promise.resolve()

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
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES
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
    throwIfCancelled(signal)
    try {
      if (options.overpassFirst && this.overpassUrls.length > 0) {
        return await this.loadFromMirrors(box, signal, onUpdate, options.refresh)
      }
      return await this.loadFromOsm(box, signal, onUpdate, options.refresh)
    } finally {
      await this.flush()
    }
  }

  /**
   * The saved routes whose box crosses the view, without any request. Used where the map
   * does not load lines, so that routes saved earlier show as soon as the map opens.
   */
  async cached(box: BoundingBox, signal: AbortSignal): Promise<RouteSource[]> {
    throwIfCancelled(signal)
    const index = await this.ready()
    const ids = Object.entries(index.routes)
      .filter(([, meta]) => meta.box !== undefined && intersects(meta.box, box))
      .map(([id]) => Number(id))
    const saved = await Promise.all(ids.map((id) => this.store.get(routeKey(id)).catch(() => undefined)))
    throwIfCancelled(signal)
    return saved.flatMap((entry) => (entry && isRoute(entry.value) ? [entry.value] : []))
  }

  private async loadFromOsm(box: BoundingBox, signal: AbortSignal, onUpdate?: (result: LoadResult) => void, refresh = false): Promise<LoadResult> {
    const index = await this.ready()
    const tiles = tilesIn(box)
    const centre = centreOf(box)
    const failures: LoadFailure[] = []
    const reported = new Set<string>()
    const report = (failure: LoadFailure) => {
      if (reported.has(failure.url)) return
      reported.add(failure.url)
      failures.push(failure)
    }
    const ctx: LoadContext = { refresh, done: new Set() }
    const onRouteError = (id: number, error: unknown) => {
      if (!signal.aborted) report({ kind: 'relation', url: relationFullUrl(this.apiUrl, id), reason: describeError(error) })
    }
    const show = async (): Promise<RouteSource[]> => {
      const routes = await this.routesFor(tiles, signal, ctx, (id, s) => this.fetchRouteOsm(id, s), onRouteError)
      if (!signal.aborted && onUpdate) onUpdate({ routes, failures: [...failures] })
      return routes
    }

    const uncovered = refresh ? tiles : await this.uncovered(tiles)
    if (!refresh) this.refreshStale(index, tiles)
    const missing = uncovered.sort(byDistance(centre)).slice(0, NEAREST_TILES)
    await Promise.all(
      missing.map(async (tile) => {
        const ids = await this.fetchTile(tile, signal, (url, error) => report({ kind: 'map', url, reason: describeError(error) }))
        if (ids && !signal.aborted) await this.markCovered(index, [tile], ids, this.now())
        if (!signal.aborted) await show()
      }),
    )
    const routes = await show()
    throwIfCancelled(signal)
    return { routes, failures }
  }

  /**
   * Loads the missing part of the box from the Overpass mirrors: one query for the whole missing area,
   * which gives IDs only. The details come from the OSM API. Nothing is asked again for covered tiles.
   */
  private async loadFromMirrors(box: BoundingBox, signal: AbortSignal, onUpdate?: (result: LoadResult) => void, refresh = false): Promise<LoadResult> {
    const index = await this.ready()
    const tiles = tilesIn(box)
    const failures: LoadFailure[] = []
    const reported = new Set<string>()
    const report = (failure: LoadFailure) => {
      if (reported.has(failure.url)) return
      reported.add(failure.url)
      failures.push(failure)
    }
    const missing = refresh ? tiles : await this.uncovered(tiles)
    if (missing.length > 0) {
      // The query covers whole tiles, so every tile in the area is covered by its answer.
      const area = areaOf(missing)
      let ids: number[]
      try {
        ids = routeIdsFrom(await this.fromMirrors(overpassRouteIdsQuery(area), signal, new TransportError('Overpass first')))
      } catch (error) {
        if (signal.aborted) throw cancelled()
        failures.push({ kind: 'map', url: this.overpassUrls[0], reason: describeError(error) })
        return { routes: [], failures }
      }
      await this.markCovered(index, tilesIn(area), ids, this.now())
    }
    const ctx: LoadContext = { refresh, done: new Set() }
    const onRouteError = (_id: number, error: unknown) => {
      if (!signal.aborted) report({ kind: 'relation', url: this.overpassUrls[0], reason: describeError(error) })
    }
    const fetchRoute = async (id: number, s: AbortSignal): Promise<RouteSource> => {
      // The details come from the OSM API, as on the OSM path. Only the IDs came from Overpass.
      const text = await this.request(relationFullUrl(this.apiUrl, id), s)
      return relationRoute(parseOsmJson(text), id)
    }
    const routes = await this.routesFor(tiles, signal, ctx, fetchRoute, onRouteError)
    if (!signal.aborted && onUpdate) onUpdate({ routes, failures: [...failures] })
    throwIfCancelled(signal)
    return { routes, failures }
  }

  /** The routes of the covered tiles. Each is read from the store, or fetched when it is not saved yet. */
  private async routesFor(
    tiles: Tile[],
    signal: AbortSignal,
    ctx: LoadContext,
    fetchRoute: (id: number, s: AbortSignal) => Promise<RouteSource>,
    onError: (id: number, error: unknown) => void,
  ): Promise<RouteSource[]> {
    const index = await this.ready()
    await this.loadCellsFor(tiles)
    const ids = this.idsOf(tiles)
    const found = await Promise.all(
      ids.map(async (id) => {
        try {
          const force = ctx.refresh && !ctx.done.has(id)
          const route = await this.routeFor(index, id, signal, force, fetchRoute)
          ctx.done.add(id)
          return route
        } catch (error) {
          onError(id, error)
          return undefined
        }
      }),
    )
    return found.filter((route): route is RouteSource => route !== undefined)
  }

  /**
   * Asks the API for the route IDs of one tile. The tile is asked for in four quarters, as the
   * API refuses larger boxes. Undefined when any quarter failed: the tile is then not kept as covered.
   */
  private async fetchTile(tile: Tile, signal: AbortSignal, fail: (url: string, error: unknown) => void): Promise<number[] | undefined> {
    const results = await Promise.all(
      splitBox(tileBox(tile)).map(async (part) => {
        try {
          return await this.fetchBox(part, signal, 0)
        } catch (error) {
          if (!signal.aborted) fail(mapUrl(this.apiUrl, part), error)
          return undefined
        }
      }),
    )
    if (results.some((ids) => ids === undefined)) return undefined
    return [...new Set(results.flatMap((ids) => ids ?? []))]
  }

  /** Route IDs in a box. A box the API refuses as too large is split into quarters and asked for in parts. */
  private async fetchBox(box: BoundingBox, signal: AbortSignal, depth: number): Promise<number[]> {
    try {
      return subwayRouteIds(parseOsmJson(await this.requestOrMirror(mapUrl(this.apiUrl, box), overpassMapQuery(box), signal)))
    } catch (error) {
      // 400 from the map call means the box holds too much data. Split it and ask for the parts.
      if (error instanceof OsmHttpError && error.status === 400 && depth < MAX_SPLIT_DEPTH) {
        const ids = new Set<number>()
        for (const part of splitBox(box)) {
          for (const id of await this.fetchBox(part, signal, depth + 1)) ids.add(id)
        }
        return [...ids]
      }
      throw error
    }
  }

  private async fetchRouteOsm(id: number, signal: AbortSignal): Promise<RouteSource> {
    const text = await this.requestOrMirror(relationFullUrl(this.apiUrl, id), overpassRelationQuery(id), signal)
    return relationRoute(parseOsmJson(text), id)
  }

  /** A route from the store when it is saved, otherwise from the network. Concurrent asks for one route share one request. */
  private routeFor(index: Index, id: number, signal: AbortSignal, force: boolean, fetchRoute: FetchRoute): Promise<RouteSource> {
    const pending = this.inflight.get(id)
    if (pending) return pending
    const task = this.resolveRoute(index, id, signal, force, this.withMaster(fetchRoute)).finally(() => this.inflight.delete(id))
    this.inflight.set(id, task)
    return task
  }

  /** Fetches a route, then sets its route_master. A failed master lookup leaves the route without one, unchecked. */
  private withMaster(fetchRoute: FetchRoute): FetchRoute {
    return async (id, signal) => {
      const route = await fetchRoute(id, signal)
      const master = await this.masterOf(id, signal)
      if (master !== undefined) route.master = master
      return route
    }
  }

  /**
   * The route_master of a route: a master, null when the route has none, or undefined when the OSM API
   * could not answer. Each answer is saved, null included, so a route is asked about once.
   */
  private async masterOf(id: number, signal: AbortSignal): Promise<RouteMaster | null | undefined> {
    const key = masterKey(id)
    const saved = await this.store.get(key).catch(() => undefined)
    if (saved && isMasterEntry(saved.value)) return saved.value.master
    try {
      const text = await this.request(`${this.apiUrl}/api/0.6/relation/${id}/relations.json`, signal)
      const master = routeMasterOf(parseOsmJson(text))
      await this.store.set(key, { value: { master }, savedAt: this.now() }).catch(() => undefined)
      return master
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  private async resolveRoute(
    index: Index,
    id: number,
    signal: AbortSignal,
    force: boolean,
    fetchRoute: (id: number, s: AbortSignal) => Promise<RouteSource>,
  ): Promise<RouteSource> {
    if (!force && index.routes[id]) {
      const saved = await this.store.get(routeKey(id)).catch(() => undefined)
      if (saved && isRoute(saved.value)) {
        index.routes[id].used = this.now()
        this.indexDirty = true
        if (this.now() - saved.savedAt >= STALE_MS || outdatedRoute(saved.value)) void this.refreshRoute(index, id, fetchRoute)
        return saved.value
      }
    }
    throwIfCancelled(signal)
    const value = await fetchRoute(id, signal)
    await this.saveRoute(index, id, value, this.now())
    return value
  }

  private async refreshRoute(index: Index, id: number, fetchRoute: (id: number, s: AbortSignal) => Promise<RouteSource>): Promise<void> {
    const key = routeKey(id)
    // One refresh per route at a time: the older copy is still stale after a view, so later views would ask again.
    if (this.refreshing.has(key)) return
    this.refreshing.add(key)
    try {
      await this.sleep(REFRESH_DELAY_MS, new AbortController().signal)
      await this.saveRoute(index, id, await fetchRoute(id, new AbortController().signal), this.now())
    } catch {
      // The older copy stays saved until a later load succeeds.
    } finally {
      this.refreshing.delete(key)
      void this.flush()
    }
  }

  /** Refreshes, in the background, the covered tiles of the view whose coverage is old. The view shows them meanwhile. */
  private refreshStale(index: Index, tiles: Tile[]): void {
    const stale = tiles.filter((tile) => {
      const segment = this.segmentOf(tile)
      return segment !== undefined && this.now() - segment.s >= STALE_MS
    })
    for (const tile of stale.slice(0, NEAREST_TILES)) void this.refreshTile(index, tile)
  }

  private async refreshTile(index: Index, tile: Tile): Promise<void> {
    const key = `tile/${tile.x}/${tile.y}`
    if (this.refreshing.has(key)) return
    this.refreshing.add(key)
    try {
      await this.sleep(REFRESH_DELAY_MS, new AbortController().signal)
      const ids = await this.fetchTile(tile, new AbortController().signal, () => undefined)
      if (ids) await this.markCovered(index, [tile], ids, this.now())
    } catch {
      // The older coverage stays until a later load succeeds.
    } finally {
      this.refreshing.delete(key)
      void this.flush()
    }
  }

  /** The tiles that no saved request covers. */
  private async uncovered(tiles: Tile[]): Promise<Tile[]> {
    await this.loadCellsFor(tiles)
    return tiles.filter((tile) => this.segmentOf(tile) === undefined)
  }

  private segmentOf(tile: Tile): Segment | undefined {
    const { key, offset } = cellOf(tile)
    return this.cells.get(key)?.at.get(offset)
  }

  /** The route IDs found for the covered tiles. Needs loadCellsFor first. */
  private idsOf(tiles: Tile[]): number[] {
    const ids = new Set<number>()
    for (const tile of tiles) {
      const segment = this.segmentOf(tile)
      if (segment) for (const id of segment.i) ids.add(id)
    }
    return [...ids]
  }

  private async loadCellsFor(tiles: Tile[]): Promise<void> {
    const keys = new Set(tiles.map((tile) => cellOf(tile).key))
    await Promise.all([...keys].map((key) => this.loadCell(key)))
  }

  private async loadCell(key: string): Promise<void> {
    // Not ready(): this runs inside the migration, which the readiness promise waits for.
    const index = this.index
    if (!index) return
    const known = this.cells.get(key)
    if (known) {
      if (index.cells[key]) {
        index.cells[key].used = this.now()
        this.indexDirty = true
      }
      return
    }
    const saved = await this.store.get(cellStoreKey(key)).catch(() => undefined)
    // A write may have loaded the cell while this read was waiting: its copy is the newer one.
    if (!saved || this.cells.has(key)) return
    const cell = saved.value as Cell
    if (!cell || !Array.isArray(cell.segs)) return
    this.cells.set(key, { cell, at: segmentIndex(cell) })
    if (!index.cells[key]) {
      index.cells[key] = { bytes: JSON.stringify(cell).length, used: this.now() }
      this.indexDirty = true
    }
  }

  /** Records that the tiles were covered by a request that found these route IDs. */
  private markCovered(index: Index, tiles: Tile[], ids: number[], savedAt: number): Promise<void> {
    return this.serial(async () => {
      const byCell = new Map<string, number[]>()
      for (const tile of tiles) {
        const { key, offset } = cellOf(tile)
        byCell.set(key, [...(byCell.get(key) ?? []), offset])
      }
      for (const [key, offsets] of byCell) {
        await this.loadCell(key)
        const current = this.cells.get(key)?.cell ?? { segs: [] }
        const fresh = new Set(offsets)
        // A tile belongs to one segment: the newest request that covered it.
        const kept = current.segs
          .map((segment) => ({ ...segment, t: segment.t.filter((offset) => !fresh.has(offset)) }))
          .filter((segment) => segment.t.length > 0)
        await this.writeCell(index, key, { segs: [...kept, { t: offsets, i: ids, s: savedAt }] })
      }
    })
  }

  private async writeCell(index: Index, key: string, cell: Cell): Promise<void> {
    this.cells.set(key, { cell, at: segmentIndex(cell) })
    index.cells[key] = { bytes: JSON.stringify(cell).length, used: this.now() }
    this.indexDirty = true
    await this.put(cellStoreKey(key), cell, this.now())
  }

  private saveRoute(index: Index, id: number, value: RouteSource, savedAt: number): Promise<void> {
    return this.serial(async () => {
      index.routes[id] = { bytes: JSON.stringify(value).length, used: this.now(), box: routeBox(value) }
      this.indexDirty = true
      await this.put(routeKey(id), value, savedAt)
    })
  }

  /** Removes the least recently used routes and coverage while they take more than the budget. */
  private async enforceBudget(index: Index): Promise<void> {
    type Item = { kind: 'route' | 'cell'; key: string; bytes: number; used: number }
    const items: Item[] = [
      ...Object.entries(index.routes).map(([key, meta]): Item => ({ kind: 'route', key, bytes: meta.bytes, used: meta.used })),
      ...Object.entries(index.cells).map(([key, meta]): Item => ({ kind: 'cell', key, bytes: meta.bytes, used: meta.used })),
    ]
    let total = items.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= this.budgetBytes) return
    items.sort((a, b) => a.used - b.used)
    for (const item of items) {
      if (total <= this.budgetBytes) break
      total -= item.bytes
      this.indexDirty = true
      if (item.kind === 'route') {
        delete index.routes[item.key]
        await this.drop(routeKey(Number(item.key)))
      } else {
        delete index.cells[item.key]
        this.cells.delete(item.key)
        await this.drop(cellStoreKey(item.key))
      }
    }
  }

  private ready(): Promise<Index> {
    this.opened ??= this.open()
    return this.opened
  }

  private async open(): Promise<Index> {
    const saved = await this.store.get(INDEX_KEY).catch(() => undefined)
    const stored = saved?.value as Partial<Index> | undefined
    const index: Index = stored && stored.routes && stored.cells ? (stored as Index) : { routes: {}, cells: {} }
    this.index = index
    if (!index.migrated) {
      try {
        await this.migrate(index)
      } catch {
        // Nothing is removed unless the move finished. The next page load tries again.
      }
    }
    return index
  }

  /** Moves version 1 entries (one per route, and one per quarter of a tile) into the current format, then removes them. */
  private async migrate(index: Index): Promise<void> {
    const entries: [string, Entry][] = (await this.store.scan?.('')) ?? []
    const legacy: string[] = []
    const quarters = new Map<string, { ids: (number[] | undefined)[]; saved: number }>()
    for (const [key, entry] of entries) {
      if (key.startsWith(LEGACY_ROUTE_PREFIX)) {
        legacy.push(key)
        const id = Number(key.slice(LEGACY_ROUTE_PREFIX.length))
        if (Number.isFinite(id) && isRoute(entry.value)) await this.saveRoute(index, id, entry.value, entry.savedAt)
      } else if (key.startsWith(LEGACY_TILE_PREFIX)) {
        legacy.push(key)
        const [, zoom, x, y, quarter] = key.split('/')
        if (zoom !== String(TILE_ZOOM) || !Array.isArray(entry.value)) continue
        const tileKeyText = `${x}/${y}`
        const slot = quarters.get(tileKeyText) ?? { ids: [undefined, undefined, undefined, undefined], saved: entry.savedAt }
        const part = Number(quarter)
        if (part >= 0 && part < 4) slot.ids[part] = entry.value as number[]
        slot.saved = Math.min(slot.saved, entry.savedAt)
        quarters.set(tileKeyText, slot)
      }
    }
    // A tile is covered when all four of its quarters were saved.
    for (const [tileKeyText, slot] of quarters) {
      if (!slot.ids.every((ids) => Array.isArray(ids))) continue
      const [x, y] = tileKeyText.split('/').map(Number)
      const ids = [...new Set(slot.ids.flatMap((part) => part ?? []))]
      await this.markCovered(index, [{ x, y, z: TILE_ZOOM }], ids, slot.saved)
    }
    for (const key of legacy) await this.drop(key)
    index.migrated = true
    this.indexDirty = true
    await this.flush()
  }

  /**
   * Applies the size limit and saves the index. Runs when a load ends, not during it, so a
   * load never loses data it has just fetched.
   */
  private async flush(): Promise<void> {
    if (!this.index) return
    await this.enforceBudget(this.index)
    if (!this.indexDirty) return
    this.indexDirty = false
    await this.put(INDEX_KEY, this.index, this.now())
  }

  /** Writes that never fail the load: a store that refuses a write just keeps nothing. */
  private async put(key: string, value: unknown, savedAt: number): Promise<void> {
    try {
      await this.store.set(key, { value, savedAt })
    } catch {
      // The data is still used for this page.
    }
  }

  private async drop(key: string): Promise<void> {
    try {
      await this.store.delete?.(key)
    } catch {
      // A key that cannot be removed is ignored.
    }
  }

  /** Runs one write after the previous one has finished. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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

function routeKey(id: number): string {
  return `${ROUTE_PREFIX}${id}`
}

function masterKey(id: number): string {
  return `${MASTER_PREFIX}${id}`
}

type FetchRoute = (id: number, s: AbortSignal) => Promise<RouteSource>

/** The route_master in the parent relations of a route, or null when there is none. Relations are read in id order. */
export function routeMasterOf(data: OsmData): RouteMaster | null {
  for (const [id, relation] of [...data.relations].sort(([a], [b]) => a - b)) {
    if (relation.tags.type === 'route_master') return { id, tags: relation.tags }
  }
  return null
}

function isMasterEntry(value: unknown): value is { master: RouteMaster | null } {
  if (typeof value !== 'object' || value === null || !('master' in value)) return false
  const master = (value as { master: unknown }).master
  return master === null || (typeof master === 'object' && master !== null)
}

function cellStoreKey(key: string): string {
  return `${CELL_PREFIX}${key}`
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

/** The relation IDs in an Overpass `out ids` answer. The query already keeps only subway routes. */
function routeIdsFrom(text: string): number[] {
  const data = JSON.parse(text) as { elements?: { type?: string; id?: number }[] }
  return (data.elements ?? []).filter((element) => element.type === 'relation' && typeof element.id === 'number').map((element) => element.id as number)
}

function centreOf(box: BoundingBox): { lat: number; lon: number } {
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 }
}

/** Squared distance in degrees. Only used to put things in order, so the projection does not matter. */
function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return (a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2
}
