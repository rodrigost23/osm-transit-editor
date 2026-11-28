import { type RouteSource } from './geojson'
import { parseOsmXml, type OsmData } from './osm-xml'
import { splitBox, tileBox, tilesCovering, type BoundingBox, type Tile } from './tiles'

// OpenStreetMap asks API clients to keep to two simultaneous requests.
const CONCURRENCY = 2
// A view covering more tiles than this is not loaded; the map asks the user to zoom in.
const MAX_TILES = 24
// A box the API refuses as too large is split into quarters, up to this depth.
const MAX_SPLIT_DEPTH = 2
// After a rate limit (429) or a bandwidth limit (509), no new requests are sent for a while.
const PAUSE_MS = 30_000

export class OsmHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

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

/** Text that says why a request failed, for the console and the notice on the map. */
export function describeError(error: unknown): string {
  if (error instanceof OsmHttpError) {
    if (error.status === 429) return 'HTTP 429 (rate limited)'
    if (error.status === 509) return 'HTTP 509 (bandwidth limit)'
    return `HTTP ${error.status}`
  }
  // fetch() rejects with a TypeError when the request never gets a response: offline, blocked, or CORS.
  if (error instanceof TypeError) return 'network error (no response: offline, blocked, or CORS)'
  if (error instanceof Error) return error.message
  return String(error)
}

/** Subway relation ids in a map response. */
export function subwayRouteIds(data: OsmData): number[] {
  return [...data.relations]
    .filter(([, relation]) => relation.tags.route === 'subway')
    .map(([id]) => id)
}

/** Builds a route from a relation and its ways. Ways outside the requested area are included. */
export function relationRoute(data: OsmData, id: number): RouteSource {
  const relation = data.relations.get(id)
  if (!relation) throw new Error(`Relation ${id} is missing from the response`)
  const lines: [number, number][][] = []
  for (const member of relation.members) {
    if (member.type !== 'way') continue
    const way = data.ways.get(member.ref)
    if (!way) continue
    const line: [number, number][] = []
    for (const ref of way.nodes) {
      const node = data.nodes.get(ref)
      if (node) line.push([node.lon, node.lat])
    }
    if (line.length > 1) lines.push(line)
  }
  return { id, tags: relation.tags, lines }
}

export function mapUrl(apiUrl: string, box: BoundingBox): string {
  // The API takes the bounds as left, bottom, right, top.
  const bbox = [box.west, box.south, box.east, box.north].join(',')
  return `${apiUrl}/api/0.6/map?bbox=${bbox}`
}

export function relationFullUrl(apiUrl: string, id: number): string {
  return `${apiUrl}/api/0.6/relation/${id}/full`
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Loads subway routes for the visible area, tile by tile. A tile or route that fails is
 * reported and the rest still loads. Loaded tiles and routes are kept, so panning back
 * and forth does not repeat requests, and failed ones are asked for again next time.
 */
export class RouteLoader {
  private readonly tileRelations = new Map<string, number[]>()
  private readonly routes = new Map<number, RouteSource>()
  private active = 0
  private readonly waiting: (() => void)[] = []
  private pausedUntil = 0

  private readonly apiUrl: string
  private readonly fetchFn: Fetch

  constructor(apiUrl: string, fetchFn: Fetch = fetch) {
    this.apiUrl = apiUrl
    this.fetchFn = fetchFn
  }

  /** Routes that cross the box, or null when the box covers too many tiles to load. */
  async load(box: BoundingBox, signal: AbortSignal): Promise<LoadResult | null> {
    const tiles = tilesCovering(box)
    if (tiles.length > MAX_TILES) return null

    const failures: LoadFailure[] = []
    const tileOutcomes = await Promise.allSettled(tiles.map((tile) => this.loadTile(tile, signal)))
    throwIfCancelled(signal)
    tileOutcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failures.push({ kind: 'map', url: mapUrl(this.apiUrl, tileBox(tiles[index])), reason: describeError(outcome.reason) })
      }
    })

    const ids = new Set<number>()
    for (const tile of tiles) {
      for (const id of this.tileRelations.get(tileKey(tile)) ?? []) ids.add(id)
    }
    const missing = [...ids].filter((id) => !this.routes.has(id))
    const routeOutcomes = await Promise.allSettled(missing.map((id) => this.loadRoute(id, signal)))
    throwIfCancelled(signal)
    routeOutcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failures.push({
          kind: 'relation',
          url: relationFullUrl(this.apiUrl, missing[index]),
          reason: describeError(outcome.reason),
        })
      }
    })

    const routes = [...ids].flatMap((id) => this.routes.get(id) ?? [])
    return { routes, failures }
  }

  private async loadTile(tile: Tile, signal: AbortSignal): Promise<void> {
    const key = tileKey(tile)
    if (this.tileRelations.has(key)) return
    const ids = await this.fetchBox(tileBox(tile), signal, 0)
    this.tileRelations.set(key, ids)
  }

  private async fetchBox(box: BoundingBox, signal: AbortSignal, depth: number): Promise<number[]> {
    let xml: string
    try {
      xml = await this.get(mapUrl(this.apiUrl, box), signal)
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
    return subwayRouteIds(parseOsmXml(xml))
  }

  private async loadRoute(id: number, signal: AbortSignal): Promise<void> {
    if (this.routes.has(id)) return
    const xml = await this.get(relationFullUrl(this.apiUrl, id), signal)
    this.routes.set(id, relationRoute(parseOsmXml(xml), id))
  }

  private get(url: string, signal: AbortSignal): Promise<string> {
    // A plain GET with no custom headers, so the browser needs no CORS preflight.
    return this.limited(signal, async () => {
      const response = await this.fetchFn(url, { signal })
      if (response.status === 429 || response.status === 509) this.pausedUntil = Date.now() + PAUSE_MS
      if (!response.ok) throw new OsmHttpError(response.status)
      return response.text()
    })
  }

  /** Runs a request once a slot is free. A slot passes straight to the next waiting request. */
  private async limited<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.active < CONCURRENCY) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      throwIfCancelled(signal)
      if (Date.now() < this.pausedUntil) throw new Error('Paused after a rate limit; not sending more requests yet')
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
}

function tileKey({ x, y, z }: Tile): string {
  return `${z}/${x}/${y}`
}
