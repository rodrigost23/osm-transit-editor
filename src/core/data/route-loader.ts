import { type RouteSource } from './geojson'
import { parseOsmXml, type OsmData } from './osm-xml'
import { splitBox, tileBox, tilesCovering, type BoundingBox, type Tile } from './tiles'

// OpenStreetMap asks API clients to keep to two simultaneous requests.
const CONCURRENCY = 2
// A view covering more tiles than this is not loaded; the map asks the user to zoom in.
const MAX_TILES = 24
// A box the API refuses as too large is split into quarters, up to this depth.
const MAX_SPLIT_DEPTH = 2

export class OsmHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`OpenStreetMap API responded ${status}`)
    this.status = status
  }
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
  const bbox = [box.west, box.south, box.east, box.north].join(',')
  return `${apiUrl}/api/0.6/map?bbox=${bbox}`
}

export function relationFullUrl(apiUrl: string, id: number): string {
  return `${apiUrl}/api/0.6/relation/${id}/full`
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Loads subway routes for the visible area, tile by tile. Tiles and routes that were
 * already loaded are kept, so panning back and forth does not repeat requests.
 */
export class RouteLoader {
  private readonly tileRelations = new Map<string, number[]>()
  private readonly routes = new Map<number, RouteSource>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  private readonly apiUrl: string
  private readonly fetchFn: Fetch

  constructor(apiUrl: string, fetchFn: Fetch = fetch) {
    this.apiUrl = apiUrl
    this.fetchFn = fetchFn
  }

  /** Routes that cross the box, or null when the box covers too many tiles to load. */
  async load(box: BoundingBox, signal: AbortSignal): Promise<RouteSource[] | null> {
    const tiles = tilesCovering(box)
    if (tiles.length > MAX_TILES) return null
    await Promise.all(tiles.map((tile) => this.loadTile(tile, signal)))

    const ids = new Set<number>()
    for (const tile of tiles) {
      for (const id of this.tileRelations.get(tileKey(tile)) ?? []) ids.add(id)
    }
    await Promise.all([...ids].filter((id) => !this.routes.has(id)).map((id) => this.loadRoute(id, signal)))
    return [...ids].flatMap((id) => this.routes.get(id) ?? [])
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
    return this.limited(signal, async () => {
      const response = await this.fetchFn(url, { signal })
      if (!response.ok) throw new OsmHttpError(response.status)
      return response.text()
    })
  }

  /** Runs a request once a slot is free. A slot passes straight to the next waiting request. */
  private async limited<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.active < CONCURRENCY) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

function tileKey({ x, y, z }: Tile): string {
  return `${z}/${x}/${y}`
}
