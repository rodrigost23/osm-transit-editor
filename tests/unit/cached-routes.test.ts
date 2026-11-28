import { describe, expect, it } from 'vitest'
import { RouteLoader } from '@/core/data/route-loader'
import { MemoryStore } from '@/core/data/store'

const BOX = { south: -22.95, west: -43.2, north: -22.88, east: -43.15 }

const MAP_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'subway', ref: '1' } },
  ],
})

const FULL_JSON = JSON.stringify({
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18 },
    { type: 'way', id: 10, nodes: [1, 2] },
    { type: 'relation', id: 7, members: [{ type: 'way', ref: 10, role: '' }], tags: { route: 'subway', ref: '1' } },
  ],
})

const okFetch = async (url: string) => new Response(url.includes('/relation/') ? FULL_JSON : MAP_JSON, { status: 200 })

describe('RouteLoader.cached', () => {
  it('returns routes saved by an earlier load, without any request', async () => {
    const store = new MemoryStore(300)
    await new RouteLoader('https://osm.test', { store, fetchFn: okFetch }).load(BOX, new AbortController().signal)

    const calls: string[] = []
    const offline = new RouteLoader('https://osm.test', {
      store,
      fetchFn: async (url: string) => {
        calls.push(url)
        throw new TypeError('Failed to fetch')
      },
    })
    const routes = await offline.cached(BOX, new AbortController().signal)
    expect(routes.map((route) => route.id)).toEqual([7])
    expect(calls).toEqual([])
  })

  it('returns nothing for an empty store', async () => {
    const loader = new RouteLoader('https://osm.test', { store: new MemoryStore(300), fetchFn: okFetch })
    expect(await loader.cached(BOX, new AbortController().signal)).toEqual([])
  })

  it('stops when the view is left before the read finishes', async () => {
    const controller = new AbortController()
    controller.abort()
    const loader = new RouteLoader('https://osm.test', { store: new MemoryStore(300), fetchFn: okFetch })
    await expect(loader.cached(BOX, controller.signal)).rejects.toThrow()
  })
})
