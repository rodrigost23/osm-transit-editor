import { describe, expect, it } from 'vitest'
import { relationRoute, RouteLoader, type LoaderOptions } from '@/core/data/route-loader'
import { parseOsmJson } from '@/core/data/osm-json'
import { MemoryStore } from '@/core/data/store'
import { tileBox, type BoundingBox } from '@/core/data/tiles'

const API = 'https://osm.test'
const MIRROR = 'https://mirror.test/api/interpreter'

const MAP_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'subway', ref: '1' } },
  ],
})
const FULL_JSON = MAP_JSON

const RIO: BoundingBox = { south: -22.95, north: -22.85, west: -43.25, east: -43.15 }
const SAO_PAULO: BoundingBox = { south: -23.6, north: -23.5, west: -46.7, east: -46.6 }
const ONE_TILE_RIO = { ...tileBox({ x: 6226, y: 9263, z: 14 }) }
const RIO_TILE: BoundingBox = {
  south: ONE_TILE_RIO.south + 0.001,
  north: ONE_TILE_RIO.north - 0.001,
  west: ONE_TILE_RIO.west + 0.001,
  east: ONE_TILE_RIO.east - 0.001,
}
const signal = () => new AbortController().signal

/** A fake network that answers the OSM API and the Overpass mirror, and records every URL it is asked for. */
function network() {
  const calls: string[] = []
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    return new Response(url.includes('/relation/') ? FULL_JSON : MAP_JSON, { status: 200 })
  }
  return { fetchFn, calls }
}

function loaderFor(net: ReturnType<typeof network>, store: MemoryStore, options: Partial<LoaderOptions> = {}) {
  return new RouteLoader(API, {
    fetchFn: net.fetchFn,
    store,
    storage: undefined,
    now: () => 0,
    sleep: async () => undefined,
    overpassUrls: [MIRROR],
    ...options,
  })
}

/** The bounds of an Overpass ID query, as south, west, north, east. */
function queryBox(url: string): number[] {
  const query = new URL(url).searchParams.get('data') ?? ''
  const match = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query)
  if (!match) throw new Error(`no box in ${query}`)
  return match.slice(1).map(Number)
}

describe('returning to a place', () => {
  it('needs no request after another city was shown, through the Overpass path', async () => {
    const net = network()
    const store = new MemoryStore(100_000)
    await loaderFor(net, store).load(RIO, signal(), undefined, { overpassFirst: true })
    await loaderFor(net, store).load(SAO_PAULO, signal(), undefined, { overpassFirst: true })
    const before = net.calls.length

    const back = await loaderFor(net, store).load(RIO, signal(), undefined, { overpassFirst: true })

    expect(net.calls.length).toBe(before)
    expect(back.routes.map((route) => route.id)).toEqual([7])
  })

  it('needs no request after another city was shown, through the OSM tile path', async () => {
    const net = network()
    const store = new MemoryStore(100_000)
    const sp = tileBox({ x: 6068, y: 9309, z: 14 })
    const saoPauloTile: BoundingBox = { south: sp.south + 0.001, north: sp.north - 0.001, west: sp.west + 0.001, east: sp.east - 0.001 }
    await loaderFor(net, store).load(RIO_TILE, signal())
    await loaderFor(net, store).load(saoPauloTile, signal())
    const before = net.calls.length

    await loaderFor(net, store).load(RIO_TILE, signal())

    expect(net.calls.length).toBe(before)
  })
})

describe('partial coverage', () => {
  it('asks the mirror only for the part of the view that is not covered yet', async () => {
    const net = network()
    const store = new MemoryStore(100_000)
    const loader = loaderFor(net, store)
    const first = RIO
    const second: BoundingBox = { south: -22.95, north: -22.85, west: -43.2, east: -43.05 }
    await loader.load(first, signal(), undefined, { overpassFirst: true })
    const mirrorBefore = net.calls.filter((url) => url.startsWith(MIRROR)).length

    await loader.load(second, signal(), undefined, { overpassFirst: true })

    const queries = net.calls.filter((url) => url.startsWith(MIRROR)).slice(mirrorBefore)
    expect(queries).toHaveLength(1)
    const [south, west, north, east] = queryBox(queries[0])
    // The covered part of the first view is left out: the query starts at its eastern edge.
    expect(west).toBeGreaterThanOrEqual(first.east - 0.001)
    expect(east).toBeGreaterThanOrEqual(second.east - 0.03)
    expect(south).toBeLessThanOrEqual(second.south)
    expect(north).toBeGreaterThanOrEqual(second.north)
  })
})

describe('moving the saved data from the old format', () => {
  it('uses old saved routes and tiles without a request, then removes the old keys', async () => {
    const store = new MemoryStore(100_000)
    const route = relationRoute(parseOsmJson(FULL_JSON), 7)
    await store.set('route/v1/7', { value: route, savedAt: 0 })
    for (let quarter = 0; quarter < 4; quarter++) {
      await store.set(`v1/14/6226/9263/${quarter}`, { value: [7], savedAt: 0 })
    }
    const net = network()

    const result = await loaderFor(net, store).load(RIO_TILE, signal())

    expect(net.calls).toEqual([])
    expect(result.routes.map((item) => item.id)).toEqual([7])
    expect(await store.get('route/v1/7')).toBeUndefined()
    expect(await store.get('v1/14/6226/9263/0')).toBeUndefined()
  })
})

describe('size limit', () => {
  it('does not keep data beyond the budget, so the next view asks again', async () => {
    const net = network()
    const store = new MemoryStore(100_000)
    const loader = loaderFor(net, store, { budgetBytes: 1 })
    await loader.load(RIO_TILE, signal())
    const before = net.calls.length

    await loader.load(RIO_TILE, signal())

    expect(net.calls.slice(before).some((url) => url.includes('/relation/7/'))).toBe(true)
  })
})
