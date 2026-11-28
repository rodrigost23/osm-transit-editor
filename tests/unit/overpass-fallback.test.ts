import { describe, expect, it } from 'vitest'
import { overpassMapQuery, overpassRelationQuery, overpassUrl, RouteLoader } from '@/core/data/route-loader'
import { MemoryStore } from '@/core/data/store'

const API = 'https://osm.test'
const MIRROR_A = 'https://mirror-a.test/api/interpreter'
const MIRROR_B = 'https://mirror-b.test/api/interpreter'
const BOX = { west: -43.19, south: -22.93, east: -43.15, north: -22.88 }

const MAP_JSON = JSON.stringify({
  elements: [{ type: 'relation', id: 7, members: [], tags: { route: 'subway', ref: '1' } }],
})
const FULL_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'subway', ref: '1' } },
  ],
})

/** A fake network: each URL maps to a status, or to a thrown network error. */
function network(answers: Record<string, number | 'network'>) {
  const calls: string[] = []
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix))
    const answer = key === undefined ? 200 : answers[key]
    if (answer === 'network') throw new TypeError('Failed to fetch')
    // The map call and the subway-relation query get the map answer; anything else gets the full answer.
    const query = new URL(url).searchParams.get('data') ?? ''
    const isMap = url.includes('/map.json') || query.includes('route"="subway')
    return new Response(answer === 200 ? (isMap ? MAP_JSON : FULL_JSON) : 'nope', { status: answer })
  }
  return { fetchFn, calls }
}

/** A clock that moves only when the loader sleeps, so retries take no real time. */
function loader(fetchFn: (url: string) => Promise<Response>, overpassUrls: string[]) {
  let time = 0
  return new RouteLoader(API, {
    fetchFn,
    store: new MemoryStore(50),
    storage: undefined,
    sleep: async (ms: number) => {
      time += ms
    },
    now: () => time,
    overpassUrls,
  })
}

describe('Overpass queries', () => {
  it('asks for subway relations in the box, as south, west, north, east', () => {
    expect(overpassMapQuery(BOX)).toBe(
      '[out:json][timeout:25];relation["route"="subway"](-22.93,-43.19,-22.88,-43.15);out body;',
    )
  })

  it('asks for one relation with its ways and nodes', () => {
    expect(overpassRelationQuery(7)).toBe('[out:json][timeout:25];relation(7);(._;>;);out body;')
  })

  it('sends the query as a GET parameter', () => {
    const url = overpassUrl(MIRROR_A, 'relation(7);out body;')
    expect(url.startsWith(`${MIRROR_A}?data=`)).toBe(true)
    expect(new URL(url).searchParams.get('data')).toBe('relation(7);out body;')
  })
})

describe('mirror fallback', () => {
  it('uses the OSM API alone when it answers', async () => {
    const net = network({})
    const result = await loader(net.fetchFn, [MIRROR_A]).load(BOX, new AbortController().signal)
    expect(result.routes.length).toBeGreaterThan(0)
    expect(net.calls.some((url) => url.startsWith(MIRROR_A))).toBe(false)
  })

  it('falls back to the first mirror when the OSM API has no answer', async () => {
    const net = network({ [API]: 'network' })
    const result = await loader(net.fetchFn, [MIRROR_A, MIRROR_B]).load(BOX, new AbortController().signal)
    expect(result.routes.length).toBeGreaterThan(0)
    expect(net.calls.some((url) => url.startsWith(MIRROR_A))).toBe(true)
    expect(net.calls.some((url) => url.startsWith(MIRROR_B))).toBe(false)
  })

  it('tries the next mirror when one fails', async () => {
    const net = network({ [API]: 'network', [MIRROR_A]: 504 })
    const result = await loader(net.fetchFn, [MIRROR_A, MIRROR_B]).load(BOX, new AbortController().signal)
    expect(result.routes.length).toBeGreaterThan(0)
    expect(net.calls.some((url) => url.startsWith(MIRROR_B))).toBe(true)
  })

  it('does not fall back on a rate limit from the OSM API', async () => {
    const net = network({ [API]: 429 })
    const result = await loader(net.fetchFn, [MIRROR_A]).load(BOX, new AbortController().signal)
    expect(net.calls.some((url) => url.startsWith(MIRROR_A))).toBe(false)
    expect(result.failures.length).toBeGreaterThan(0)
  })

  it('reports the OSM failure when every mirror fails too', async () => {
    const net = network({ [API]: 'network', [MIRROR_A]: 'network' })
    const result = await loader(net.fetchFn, [MIRROR_A]).load(BOX, new AbortController().signal)
    expect(result.routes).toEqual([])
    expect(result.failures.length).toBeGreaterThan(0)
  })

  it('asks the mirrors first for IDs when overpassFirst is set', async () => {
    const net = network({})
    const result = await loader(net.fetchFn, [MIRROR_A]).load(BOX, new AbortController().signal, undefined, { overpassFirst: true })
    expect(result.routes.length).toBeGreaterThan(0)
    // The IDs come from Overpass in one query. The route details come from the OSM API.
    expect(net.calls.filter((url) => url.startsWith(MIRROR_A)).length).toBe(1)
    expect(net.calls.some((url) => url.includes('/relation/7/full.json'))).toBe(true)
  })

  it('answers a second view of the same quarters from the store, without the box query', async () => {
    const net = network({})
    const store = new MemoryStore(500)
    let time = 0
    const make = () =>
      new RouteLoader(API, {
        fetchFn: net.fetchFn,
        store,
        storage: undefined,
        sleep: async (ms: number) => {
          time += ms
        },
        now: () => time,
        overpassUrls: [MIRROR_A],
      })
    await make().load(BOX, new AbortController().signal, undefined, { overpassFirst: true })
    const before = net.calls.filter((url) => url.startsWith(MIRROR_A)).length
    const again = await make().load(BOX, new AbortController().signal, undefined, { overpassFirst: true })
    const after = net.calls.filter((url) => url.startsWith(MIRROR_A)).length
    expect(again.routes.length).toBeGreaterThan(0)
    // Only the box query would be new; the route is saved too, so nothing is sent.
    expect(after).toBe(before)
  })
})
