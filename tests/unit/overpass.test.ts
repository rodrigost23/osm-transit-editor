import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSubwayRoutes,
  localEndpointMemory,
  orderEndpoints,
  resetEndpointCooldowns,
  subwayRoutesQuery,
  type EndpointMemory,
  type FetchLike,
} from '@/core/data/overpass'

const box = { south: -23, west: -43.3, north: -22.8, east: -43.1 }
const json = { elements: [{ type: 'relation', id: 1 }] }
const ok = () => new Response(JSON.stringify(json), { status: 200 })
const hosts = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.map(([url]) => new URL(url as string).host)
/** Never answers on its own; rejects when the client cancels it. */
const hang: FetchLike = (_url, init) =>
  new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))),
  )
const noMemory: EndpointMemory = { read: () => undefined, write: () => {} }

beforeEach(() => resetEndpointCooldowns())
afterEach(() => vi.unstubAllGlobals())

describe('subway routes query', () => {
  it('asks for subway routes in the box with member geometry and a size limit', () => {
    expect(subwayRoutesQuery(box)).toBe(
      '[out:json][timeout:10][maxsize:16777216];relation["route"="subway"](-23,-43.3,-22.8,-43.1);out geom qt;',
    )
  })
})

describe('server order', () => {
  it('puts the remembered server first when it is in the list', () => {
    expect(orderEndpoints(['https://a.test', 'https://b.test'], 'https://b.test')).toEqual([
      'https://b.test',
      'https://a.test',
    ])
  })

  it('keeps the configured order when nothing is remembered or the remembered server is gone', () => {
    expect(orderEndpoints(['https://a.test', 'https://b.test'], undefined)).toEqual(['https://a.test', 'https://b.test'])
    expect(orderEndpoints(['https://a.test', 'https://b.test'], 'https://old.test')).toEqual([
      'https://a.test',
      'https://b.test',
    ])
  })
})

describe('endpoint memory', () => {
  const fakeStorage = () => {
    const items = new Map<string, string>()
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    }
  }

  it('remembers the last working server for a day', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    let clock = 1_000
    const memory = localEndpointMemory(() => clock)
    memory.write('https://b.test')
    expect(memory.read()).toBe('https://b.test')
    clock += 25 * 60 * 60 * 1000
    expect(memory.read()).toBeUndefined()
  })

  it('does nothing harmful when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const memory = localEndpointMemory()
    expect(() => memory.write('https://b.test')).not.toThrow()
    expect(memory.read()).toBeUndefined()
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

  it('does not ask a second server while the first answers in time', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok())
    await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, hedgeMs: 1_000_000, memory: noMemory })
    expect(hosts(fetchFn)).toEqual(['a.test'])
  })

  it('asks the next server when the first is silent, and cancels the first once one answers', async () => {
    const fetchFn = vi.fn<FetchLike>((url, init) => (url === 'https://a.test' ? hang(url, init) : Promise.resolve(ok())))
    const result = await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, {
      fetchFn,
      hedgeMs: 5,
      timeoutMs: 10_000,
      memory: noMemory,
    })
    expect(result).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
    const slowSignal = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].signal
    expect(slowSignal?.aborted).toBe(true)
  })

  it('moves to the next server at once on 502, without repeating the failed one', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('bad gateway', { status: 502 }) : ok(),
    )
    expect(
      await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, hedgeMs: 1_000_000, memory: noMemory }),
    ).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
  })

  it('tries the remembered server first and remembers whichever answers', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ok())
    const written: string[] = []
    const memory: EndpointMemory = { read: () => 'https://b.test', write: (endpoint) => written.push(endpoint) }
    await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, memory })
    expect(hosts(fetchFn)).toEqual(['b.test'])
    expect(written).toEqual(['https://b.test'])
  })

  it('skips a server that failed recently, then tries it again after the cooldown', async () => {
    let clock = 0
    const now = () => clock
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('busy', { status: 503 }) : ok(),
    )
    const endpoints = ['https://a.test', 'https://b.test']
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
    clock = 30_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test', 'b.test'])
    clock = 61_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
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
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
    clock = 9_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test', 'b.test'])
    clock = 11_000
    await fetchSubwayRoutes(endpoints, box, { fetchFn, now, memory: noMemory })
    expect(hosts(fetchFn).slice(-2)).toEqual(['a.test', 'b.test'])
  })

  it('gives up on a server that does not answer within the timeout and moves on', async () => {
    const fetchFn = vi.fn<FetchLike>((url, init) => (url === 'https://a.test' ? hang(url, init) : Promise.resolve(ok())))
    expect(
      await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, timeoutMs: 10, memory: noMemory }),
    ).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
  })

  it('moves on from a 406 or 403 from one server, since it is specific to that server', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('not acceptable', { status: 406 }) : ok(),
    )
    expect(
      await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, hedgeMs: 1_000_000, memory: noMemory }),
    ).toEqual(json)
    expect(hosts(fetchFn)).toEqual(['a.test', 'b.test'])
  })

  it('stops at once on an error another server would not fix', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response('bad query', { status: 400 }))
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, hedgeMs: 1_000_000, memory: noMemory }),
    ).rejects.toThrow('400')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('names each failed server and its status when all fail', async () => {
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test' ? new Response('busy', { status: 429 }) : new Response('busy', { status: 502 }),
    )
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, { fetchFn, memory: noMemory }),
    ).rejects.toThrow('All Overpass endpoints failed (a.test: 429; b.test: 502)')
  })

  it('does not try other servers after the caller cancels', async () => {
    const caller = new AbortController()
    const fetchFn = vi.fn<FetchLike>(async (url, init) => {
      caller.abort()
      return hang(url, init)
    })
    await expect(
      fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, {
        fetchFn,
        signal: caller.signal,
        hedgeMs: 1_000_000,
        memory: noMemory,
      }),
    ).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
