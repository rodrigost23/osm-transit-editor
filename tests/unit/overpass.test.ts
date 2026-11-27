import { describe, expect, it, vi } from 'vitest'
import { fetchSubwayRoutes, subwayRoutesQuery } from '@/core/data/overpass'

const box = { south: -23, west: -43.3, north: -22.8, east: -43.1 }

describe('subway routes query', () => {
  it('asks for subway routes in the box with member geometry', () => {
    expect(subwayRoutesQuery(box)).toBe(
      '[out:json][timeout:25];relation["route"="subway"](-23,-43.3,-22.8,-43.1);out geom;',
    )
  })
})

describe('fetchSubwayRoutes', () => {
  it('posts the query as form data and returns the elements', async () => {
    const json = { elements: [{ type: 'relation', id: 1 }] }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }))
    const result = await fetchSubwayRoutes('https://example.test/api', box, fetchFn)
    expect(result).toEqual(json)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/api')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('route')
  })

  it('throws when the server answers with an error', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 429 }))
    await expect(fetchSubwayRoutes('https://example.test/api', box, fetchFn)).rejects.toThrow('429')
  })
})
