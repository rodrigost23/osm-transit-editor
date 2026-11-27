import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSubwayRoutes,
  resetEndpointCooldowns,
  subwayRoutesQuery,
  type FetchLike,
} from '@/core/data/overpass'

const box = { south: -23, west: -43.3, north: -22.8, east: -43.1 }
const json = { elements: [{ type: 'relation', id: 1 }] }
const ok = () => new Response(JSON.stringify(json), { status: 200 })
const hosts = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.map(([url]) => new URL(url as string).host)

beforeEach(() => resetEndpointCooldowns())

describe('subway routes query', () => {
  it('asks for subway routes in the box with member geometry and a size limit', () => {
    expect(subwayRoutesQuery(box)).toBe(
      '[out:json][timeout:15][maxsize:16777216];relation["route"="subway"](-23,-43.3,-22.8,-43.1);out geom;',
    )
  })
})

describe('fetchSubwayRoutes', () => {
  it('posts the query as form data and returns the elements', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok())
    expect(await fetchSubwayRoutes(['https://a.test/api'], box, { fetchFn })).toEqual(json)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://a.test/api')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('route')
  })

  it('moves to the next server on 502 without repeating the failed one', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('bad gateway', { status: 502 }) : ok(),
    )
    expect(await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn })).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
  })

  it('skips a server that failed recently, then tries it again after the cooldown', async () => {
    let clock = 0
    const now = () => clock
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('busy', { status: 503 }) : ok(),
    )
    const endpoints = ['https://a.test', 'https://b.test']
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    clock = 30_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test', 'b.test'])
    clock = 61_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    expect(hosts(fetchFn).slice(-2)).toEqual(['a.test', 'b.test'])
  })

  it('uses Retry-After as the cooldown for a rate-limited server', async () => {
    let clock = 0
    const now = () => clock
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test'
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '10' } })
        : ok(),
    )
    const endpoints = ['https://a.test', 'https://b.test']
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    clock = 9_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test', 'b.test'])
    clock = 11_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now })
    expect(hosts(fetchFn).slice(-2)).toEqual(['a.test', 'b.test'])
  })

  it('moves on when a server does not answer within the timeout', async () => {
    const fetchFn = vi.fn<FetchLike>((url, init) =>
      url === 'https://a.test'
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))),
          )
        : Promise.resolve(ok()),
    )
    expect(
      await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, timeoutMs: 10 }),
    ).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
  })

  it('stops at once on an error another server would not fix', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response('bad query', { status: 400 }))
    await expect(fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn })).rejects.toThrow('400')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('names each failed server and its status when all fail', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('busy', { status: 429 }) : new Response('busy', { status: 502 }),
    )
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn }),
    ).rejects.toThrow('All Overpass endpoints failed (a.test: 429; b.test: 502)')
  })

  it('does not try other servers after the caller cancels', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn<FetchLike>(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, signal: controller.signal }),
    ).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
