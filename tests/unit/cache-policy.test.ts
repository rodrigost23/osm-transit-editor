import { describe, expect, it, vi } from 'vitest'
import { RouteLoader, type CooldownStorage } from '@/core/data/route-loader'
import { MemoryStore } from '@/core/data/store'

const BOX = { south: -22.95, west: -43.2, north: -22.88, east: -43.15 }
const MAP_JSON = JSON.stringify({
  elements: [{ type: 'relation', id: 7, members: [], tags: { route: 'subway', ref: '1' } }],
})
const FULL_JSON = JSON.stringify({
  elements: [{ type: 'relation', id: 7, members: [], tags: { route: 'subway', ref: '1' } }],
})

function memoryStorage(): CooldownStorage {
  const items = new Map<string, string>()
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) }
}

function clock() {
  let time = 0
  return { now: () => time, sleep: async (ms: number) => void (time += ms), get time() { return time } }
}

describe('cooldown kept across page loads', () => {
  it('waits out a cooldown saved by an earlier page before asking again', async () => {
    const storage = memoryStorage()
    const timer = clock()
    const limited = vi.fn(async () => new Response('busy', { status: 429 }))
    const first = new RouteLoader('https://osm.test', { fetchFn: limited, store: new MemoryStore(10), storage, now: timer.now, sleep: timer.sleep })
    await first.load(BOX, new AbortController().signal)
    const callsBeforeReload = limited.mock.calls.length

    // A reload: a new loader reads the same storage, at the same moment.
    const okCalls: string[] = []
    const reloaded = new RouteLoader('https://osm.test', {
      fetchFn: async (url: string) => {
        okCalls.push(url)
        return new Response(MAP_JSON, { status: 200 })
      },
      store: new MemoryStore(10),
      storage,
      now: timer.now,
      sleep: timer.sleep,
    })
    expect(reloaded.cooldownLeft()).toBeGreaterThan(0)
    const started = timer.time
    await reloaded.load(BOX, new AbortController().signal)
    expect(timer.time - started).toBeGreaterThanOrEqual(60_000)
    expect(callsBeforeReload).toBeGreaterThan(0)
    expect(okCalls.length).toBeGreaterThan(0)
  })

  it('doubles the cooldown when a rate limit follows the last one soon after', async () => {
    const storage = memoryStorage()
    const timer = clock()
    const loader = new RouteLoader('https://osm.test', {
      fetchFn: async () => new Response('busy', { status: 429 }),
      store: new MemoryStore(10),
      storage,
      now: timer.now,
      sleep: timer.sleep,
    })
    await loader.load(BOX, new AbortController().signal).catch(() => undefined)
    const first = JSON.parse(storage.getItem('osm-api-cooldown') ?? '{}') as { until: number; streak: number }
    // Each rate limit after a cooldown ends escalates it, up to the maximum.
    expect(first.streak).toBeGreaterThan(1)
    expect(first.until - timer.time).toBeLessThanOrEqual(15 * 60_000)
  })

  it('works without storage, for the page only', () => {
    const loader = new RouteLoader('https://osm.test', { fetchFn: async () => new Response(MAP_JSON), store: new MemoryStore(10), storage: undefined })
    expect(loader.cooldownLeft()).toBe(0)
  })
})

describe('saved routes', () => {
  it('refreshes once a saved route that has no stations, and keeps showing it', async () => {
    const store = new MemoryStore(10)
    const timer = clock()
    await store.set('route/v1/7', { value: { id: 7, tags: { route: 'subway' }, lines: [] }, savedAt: timer.now() })
    const calls: string[] = []
    const loader = new RouteLoader('https://osm.test', {
      fetchFn: async (url: string) => {
        calls.push(url)
        return new Response(url.includes('/relation/') ? FULL_JSON : MAP_JSON, { status: 200 })
      },
      store,
      now: timer.now,
      sleep: timer.sleep,
    })
    const result = await loader.load(BOX, new AbortController().signal)
    expect(result.routes.map((route) => route.id)).toEqual([7])
    await vi.waitFor(() => expect(calls.some((url) => url.includes('/relation/7/'))).toBe(true))
  })
})
