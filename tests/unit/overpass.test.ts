import { describe, expect, it, vi } from 'vitest'
import { fetchSubwayRoutes, subwayRoutesQuery, type FetchLike } from '@/core/data/overpass'

const box = { south: -23, west: -43.3, north: -22.8, east: -43.1 }
const json = { elements: [{ type: 'relation', id: 1 }] }
const ok = () => new Response(JSON.stringify(json), { status: 200 })
const noWait = async () => {}

describe('subway routes query', () => {
  it('asks for subway routes in the box with member geometry and a size limit', () => {
    expect(subwayRoutesQuery(box)).toBe(
      '[out:json][timeout:25][maxsize:16777216];relation["route"="subway"](-23,-43.3,-22.8,-43.1);out geom;',
    )
  })
})

describe('fetchSubwayRoutes', () => {
  it('posts the query as form data and returns the elements', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok())
    const result = await fetchSubwayRoutes(['https://example.test/api'], box, { fetchFn, wait: noWait })
    expect(result).toEqual(json)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/api')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('route')
  })

  it('retries a busy endpoint once before giving up on it', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok()).mockImplementationOnce(async () => new Response('busy', { status: 502 }))
    await fetchSubwayRoutes(['https://a.test'], box, { fetchFn, wait: noWait })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('falls back to the next endpoint when one stays busy', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('busy', { status: 503 }) : ok(),
    )
    const result = await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, wait: noWait })
    expect(result).toEqual(json)
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://a.test',
      'https://a.test',
      'https://b.test',
    ])
  })

  it('stops at once on an error a different endpoint would not fix', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response('bad query', { status: 400 }))
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, wait: noWait }),
    ).rejects.toThrow('400')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports that every endpoint failed', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response('busy', { status: 429 }))
    await expect(fetchSubwayRoutes(['https://a.test'], box, { fetchFn, wait: noWait })).rejects.toThrow(
      'All Overpass endpoints failed',
    )
  })

  it('does not retry after the caller cancels', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn<FetchLike>(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, wait: noWait, signal: controller.signal }),
    ).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
