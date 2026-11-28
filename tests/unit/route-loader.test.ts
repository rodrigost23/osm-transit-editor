import { describe, expect, it, vi } from 'vitest'
import { describeError, relationRoute, RouteLoader, subwayRouteIds } from '@/core/data/route-loader'
import { parseOsmJson } from '@/core/data/osm-json'
import { LayeredStore, MemoryStore, type Store } from '@/core/data/store'
import { tileBox } from '@/core/data/tiles'

const API = 'https://osm.test'

// Map response for a view: a subway route (7), a bus route (8) and a way that is not a route.
const MAP_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'subway', ref: '1', colour: '#f58220' } },
    { type: 'relation', id: 8, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'bus' } },
  ],
})

// Full response for the subway route: its ways and their nodes, including one outside the tile.
const FULL_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'node', id: 3, lat: -22.95, lon: -43.1 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'way', id: 11, nodes: [2, 3] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }, { type: 'way', ref: 11, role: '' }], tags: { route: 'subway', ref: '1' } },
  ],
})

interface FakeOptions {
  maxWidth?: number
  failFull?: number | 'network'
  failMap?: number | 'network'
  failMapOnce?: number
}

function fakeApi(options: FakeOptions = {}) {
  const calls: string[] = []
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    if (url.includes('/relation/')) {
      if (options.failFull === 'network') throw new TypeError('Failed to fetch')
      if (options.failFull) return new Response('nope', { status: options.failFull })
      return new Response(FULL_JSON, { status: 200 })
    }
    const mapCalls = calls.filter((call) => call.includes('/map.json')).length
    if (options.failMap === 'network') throw new TypeError('Failed to fetch')
    if (options.failMap) return new Response('nope', { status: options.failMap })
    if (options.failMapOnce && mapCalls === 1) return new Response('busy', { status: options.failMapOnce })
    const bbox = new URL(url).searchParams.get('bbox') ?? ''
    const [west = 0, , east = 0] = bbox.split(',').map(Number)
    if (options.maxWidth && east - west > options.maxWidth) return new Response('too big', { status: 400 })
    return new Response(MAP_JSON, { status: 200 })
  }
  return { fetchFn, calls, count: (part: string) => calls.filter((url) => url.includes(part)).length }
}

/** A clock that moves only when the loader sleeps, so retries and cooldowns take no real time. */
function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
    get time() {
      return time
    },
  }
}

function loaderFor(api: ReturnType<typeof fakeApi>, clock = fakeClock(), store: Store = new MemoryStore(300)) {
  return new RouteLoader(API, { fetchFn: api.fetchFn, store, now: clock.now, sleep: clock.sleep })
}

const tile = tileBox({ x: 6226, y: 9263, z: 14 })
const oneTile = { south: tile.south + 0.001, north: tile.north - 0.001, west: tile.west + 0.001, east: tile.east - 0.001 }
const signal = () => new AbortController().signal

describe('route helpers', () => {
  it('finds the subway relations in a map response', () => {
    expect(subwayRouteIds(parseOsmJson(MAP_JSON))).toEqual([7])
  })

  it('keeps the whole route, including ways outside the requested tile', () => {
    const route = relationRoute(parseOsmJson(FULL_JSON), 7)
    expect(route.tags).toMatchObject({ route: 'subway', ref: '1' })
    expect(route.lines).toEqual([
      [
        [-43.19, -22.9],
        [-43.18, -22.91],
      ],
      [
        [-43.18, -22.91],
        [-43.1, -22.95],
      ],
    ])
  })

  it('skips members missing from the response, and throws for an unknown relation', () => {
    const json = JSON.stringify({ elements: [{ type: 'relation', id: 5, members: [{ type: 'way', ref: 99 }, { type: 'node', ref: 1 }] }] })
    expect(relationRoute(parseOsmJson(json), 5).lines).toEqual([])
    expect(() => relationRoute(parseOsmJson(json), 6)).toThrow('Relation 6')
  })

  it('describes errors for the console and the notice', () => {
    expect(describeError(new Error('HTTP 400'))).toBe('HTTP 400')
    expect(describeError('plain')).toBe('plain')
  })
})

describe('RouteLoader', () => {
  it('asks for each quarter of the nearest tile, then one route, and returns that route', async () => {
    const api = fakeApi()
    const result = await loaderFor(api).load(oneTile, signal())
    expect(result.routes.map((route) => route.id)).toEqual([7])
    expect(result.failures).toEqual([])
    expect(api.count('/map.json?bbox=')).toBe(4)
    expect(api.count('/relation/7/full.json')).toBe(1)
  })

  it('redraws as parts of the view arrive', async () => {
    const api = fakeApi()
    const updates: number[] = []
    await loaderFor(api).load(oneTile, signal(), (partial) => updates.push(partial.routes.length))
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)).toBe(1)
  })

  it('keeps fresh results and asks for nothing again', async () => {
    const api = fakeApi()
    const loader = loaderFor(api)
    await loader.load(oneTile, signal())
    const before = api.calls.length
    await loader.load(oneTile, signal())
    expect(api.calls.length).toBe(before)
  })

  it('splits a quarter the API refuses as too large, down to smaller boxes', async () => {
    const api = fakeApi({ maxWidth: 0.006 })
    const result = await loaderFor(api).load(oneTile, signal())
    expect(result.routes.map((route) => route.id)).toEqual([7])
    // Each quarter is refused once, then its four parts are asked for: 5 requests per quarter.
    expect(api.count('/map.json?bbox=')).toBe(20)
  })

  it('loads only the tiles nearest the middle of a wide view', async () => {
    const api = fakeApi()
    await loaderFor(api).load({ south: -22.95, north: -22.85, west: -43.25, east: -43.1 }, signal())
    expect(api.count('/map.json?bbox=')).toBe(24)
  })

  it('reports a failed route and still returns the others', async () => {
    const api = fakeApi({ failFull: 500 })
    const result = await loaderFor(api).load(oneTile, signal())
    expect(result.routes).toEqual([])
    expect(result.failures).toEqual([{ kind: 'relation', url: `${API}/api/0.6/relation/7/full.json`, reason: 'HTTP 500' }])
  })

  it('waits out a server overload and then succeeds', async () => {
    const api = fakeApi({ failMapOnce: 503 })
    const clock = fakeClock()
    const result = await loaderFor(api, clock).load(oneTile, signal())
    expect(result.failures).toEqual([])
    expect(result.routes.map((route) => route.id)).toEqual([7])
    expect(clock.time).toBeGreaterThanOrEqual(30_000)
  })

  it('retries network errors until the retry window is over, then reports them', async () => {
    const api = fakeApi({ failMap: 'network' })
    const result = await loaderFor(api).load(oneTile, signal())
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures[0].reason).toContain('network error')
    expect(api.count('/map.json?bbox=')).toBeGreaterThan(4)
  })

  it('does not keep failed results, so the next load asks again', async () => {
    const api = fakeApi({ failFull: 500 })
    const loader = loaderFor(api)
    await loader.load(oneTile, signal())
    const before = api.count('/relation/7/full.json')
    await loader.load(oneTile, signal())
    expect(api.count('/relation/7/full.json')).toBe(before + 1)
  })

  it('shows a saved result that is past its freshness at once, and refreshes it in the background', async () => {
    const api = fakeApi()
    const clock = fakeClock()
    const loader = loaderFor(api, clock)
    await loader.load(oneTile, signal())
    clock.sleep(25 * 60 * 60 * 1000)
    const before = api.calls.length
    const result = await loader.load(oneTile, signal())
    expect(result.routes.map((route) => route.id)).toEqual([7])
    await vi.waitFor(() => expect(api.calls.length).toBeGreaterThan(before))
  })

  it('still loads from the network when the disk cache never answers', async () => {
    // Reproduces a stuck IndexedDB: the loader must not wait on it before asking the API.
    const api = fakeApi()
    const stuck: Store = { get: () => new Promise<never>(() => {}), set: () => new Promise<never>(() => {}) }
    const store = new LayeredStore(new MemoryStore(300), stuck, 10)
    const result = await loaderFor(api, fakeClock(), store).load(oneTile, signal())
    expect(result.routes.map((route) => route.id)).toEqual([7])
    expect(api.count('/map.json?bbox=')).toBe(4)
  })

  it('stops when the view is cancelled before the request starts', async () => {
    const api = fakeApi()
    const controller = new AbortController()
    controller.abort()
    await expect(loaderFor(api).load(oneTile, controller.signal)).rejects.toThrow()
    expect(api.calls).toHaveLength(0)
  })
})

describe('track ways only', () => {
  it('leaves out platforms, stops and areas, and keeps the track', () => {
    const json = JSON.stringify({
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 0 },
        { type: 'node', id: 2, lat: 1, lon: 1 },
        { type: 'way', id: 10, nodes: [1, 2], tags: {} },
        { type: 'way', id: 11, nodes: [1, 2], tags: { railway: 'platform' } },
        { type: 'way', id: 12, nodes: [1, 2], tags: { public_transport: 'platform' } },
        { type: 'way', id: 13, nodes: [1, 2], tags: { area: 'yes' } },
        {
          type: 'relation',
          id: 5,
          members: [
            { type: 'way', ref: 10, role: '' },
            { type: 'way', ref: 10, role: 'forward' },
            { type: 'way', ref: 11, role: '' },
            { type: 'way', ref: 12, role: 'platform' },
            { type: 'way', ref: 13, role: 'platform' },
          ],
          tags: { route: 'subway' },
        },
      ],
    })
    // Way 10 appears twice, once for each track role; the other ways are platforms or areas.
    expect(relationRoute(parseOsmJson(json), 5).lines).toHaveLength(2)
  })
})
