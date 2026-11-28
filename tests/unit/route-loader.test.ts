import { describe, expect, it } from 'vitest'
import { relationRoute, RouteLoader } from '@/core/data/route-loader'
import { parseOsmXml } from '@/core/data/osm-xml'
import { tileBox } from '@/core/data/tiles'

const API = 'https://osm.test'

// Map response for one tile: a subway route (7), a bus route (8) and a way that is not a route.
const MAP_XML = `<osm version="0.6">
  <node id="1" lat="-22.9" lon="-43.19"/>
  <node id="2" lat="-22.91" lon="-43.18"/>
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <relation id="7"><member type="way" ref="10" role=""/><tag k="route" v="subway"/><tag k="ref" v="1"/><tag k="colour" v="#f58220"/></relation>
  <relation id="8"><member type="way" ref="10" role=""/><tag k="route" v="bus"/></relation>
</osm>`

// Full response for the subway route: its ways and their nodes, including one outside the tile.
const FULL_XML = `<osm version="0.6">
  <node id="1" lat="-22.9" lon="-43.19"/>
  <node id="2" lat="-22.91" lon="-43.18"/>
  <node id="3" lat="-22.95" lon="-43.10"/>
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/></way>
  <relation id="7"><member type="way" ref="10" role=""/><member type="way" ref="11" role=""/><tag k="route" v="subway"/><tag k="ref" v="1"/></relation>
</osm>`

function fakeApi(options: { maxWidth?: number; delayMs?: number; failMap?: number | 'network'; failFull?: number | 'network' } = {}) {
  const calls: string[] = []
  let active = 0
  let peak = 0
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    active++
    peak = Math.max(peak, active)
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (url.includes('/relation/')) {
        if (options.failFull === 'network') throw new TypeError('Failed to fetch')
        if (options.failFull) return new Response('nope', { status: options.failFull })
        return new Response(FULL_XML, { status: 200 })
      }
      if (options.failMap === 'network') throw new TypeError('Failed to fetch')
      if (options.failMap && calls.filter((call) => call.includes('/map?')).length === 1) {
        return new Response('nope', { status: options.failMap })
      }
      const bbox = new URL(url).searchParams.get('bbox') ?? ''
      const [west = 0, , east = 0] = bbox.split(',').map(Number)
      if (options.maxWidth && east - west > options.maxWidth) return new Response('too big', { status: 400 })
      return new Response(MAP_XML, { status: 200 })
    } finally {
      active--
    }
  }
  return { fetchFn, calls, peak: () => peak }
}

const tile = tileBox({ x: 6226, y: 9263, z: 14 })
const oneTile = { south: tile.south + 0.001, north: tile.north - 0.001, west: tile.west + 0.001, east: tile.east - 0.001 }
const signal = () => new AbortController().signal

describe('relationRoute', () => {
  it('keeps the whole route, including ways outside the requested tile', () => {
    const route = relationRoute(parseOsmXml(FULL_XML), 7)
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
})

describe('relationRoute edge cases', () => {
  it('skips members that are missing from the response and throws for an unknown relation', () => {
    const xml = `<osm><relation id="5"><member type="way" ref="99" role=""/><member type="node" ref="1" role=""/><tag k="route" v="subway"/></relation></osm>`
    expect(relationRoute(parseOsmXml(xml), 5).lines).toEqual([])
    expect(() => relationRoute(parseOsmXml(xml), 6)).toThrow('Relation 6')
  })
})

describe('RouteLoader', () => {
  it('loads the subway routes of the visible tiles and only those', async () => {
    const api = fakeApi()
    const result = await new RouteLoader(API, api.fetchFn).load(oneTile, signal())
    expect(result?.routes.map((route) => route.id)).toEqual([7])
    expect(result?.failures).toEqual([])
    expect(api.calls).toEqual([
      expect.stringContaining('/api/0.6/map?bbox='),
      `${API}/api/0.6/relation/7/full`,
    ])
  })

  it('reuses loaded tiles and routes instead of asking again', async () => {
    const api = fakeApi()
    const loader = new RouteLoader(API, api.fetchFn)
    await loader.load(oneTile, signal())
    const before = api.calls.length
    await loader.load(oneTile, signal())
    expect(api.calls.length).toBe(before)
  })

  it('splits a box the API refuses as too large, then keeps the routes it finds', async () => {
    const api = fakeApi({ maxWidth: 0.015 })
    const result = await new RouteLoader(API, api.fetchFn).load(oneTile, signal())
    expect(result?.routes.map((route) => route.id)).toEqual([7])
    // The whole tile is refused, then its four quarters are asked for.
    expect(api.calls.filter((url) => url.includes('/map?')).length).toBe(5)
  })

  it('does not load a view that covers too many tiles', async () => {
    const api = fakeApi()
    const wide = { south: 0, north: 0.5, west: -43.5, east: -42.5 }
    expect(await new RouteLoader(API, api.fetchFn).load(wide, signal())).toBeNull()
    expect(api.calls).toHaveLength(0)
  })

  it('keeps no more than two requests in flight', async () => {
    const api = fakeApi({ delayMs: 5 })
    const first = tileBox({ x: 6226, y: 9263, z: 14 })
    const last = tileBox({ x: 6227, y: 9264, z: 14 })
    const box = { south: last.south + 0.001, north: first.north - 0.001, west: first.west + 0.001, east: last.east - 0.001 }
    await new RouteLoader(API, api.fetchFn).load(box, signal())
    expect(api.calls.filter((url) => url.includes('/map?'))).toHaveLength(4)
    expect(api.peak()).toBe(2)
  })

  it('stops when the view is cancelled before the request starts', async () => {
    const api = fakeApi()
    const controller = new AbortController()
    controller.abort()
    await expect(new RouteLoader(API, api.fetchFn).load(oneTile, controller.signal)).rejects.toThrow()
    expect(api.calls).toHaveLength(0)
  })

  it('reports a failed relation and still returns the routes that loaded', async () => {
    const api = fakeApi({ failFull: 500 })
    const result = await new RouteLoader(API, api.fetchFn).load(oneTile, signal())
    expect(result?.routes).toEqual([])
    expect(result?.failures).toEqual([{ kind: 'relation', url: `${API}/api/0.6/relation/7/full`, reason: 'HTTP 500' }])
  })

  it('draws the tiles that loaded when one tile fails', async () => {
    const api = fakeApi({ failMap: 503 })
    const first = tileBox({ x: 6226, y: 9263, z: 14 })
    const last = tileBox({ x: 6227, y: 9264, z: 14 })
    const box = { south: last.south + 0.001, north: first.north - 0.001, west: first.west + 0.001, east: last.east - 0.001 }
    const result = await new RouteLoader(API, api.fetchFn).load(box, signal())
    expect(result?.routes.map((route) => route.id)).toEqual([7])
    expect(result?.failures).toEqual([expect.objectContaining({ kind: 'map', reason: 'HTTP 503' })])
  })

  it('explains a network failure, such as a blocked or CORS request', async () => {
    const api = fakeApi({ failMap: 'network' })
    const result = await new RouteLoader(API, api.fetchFn).load(oneTile, signal())
    expect(result?.failures[0].reason).toContain('network error')
  })

  it('stops sending requests for a while after a rate limit', async () => {
    const api = fakeApi({ failMap: 429 })
    const first = tileBox({ x: 6226, y: 9263, z: 14 })
    const last = tileBox({ x: 6229, y: 9266, z: 14 })
    const box = { south: last.south + 0.001, north: first.north - 0.001, west: first.west + 0.001, east: last.east - 0.001 }
    const result = await new RouteLoader(API, api.fetchFn).load(box, signal())
    // Two requests were already in flight; the other tiles are not sent.
    expect(api.calls.filter((url) => url.includes('/map?'))).toHaveLength(2)
    expect(result?.failures.every((failure) => failure.reason.startsWith('HTTP 429') || failure.reason.startsWith('Paused'))).toBe(true)
  })
})
