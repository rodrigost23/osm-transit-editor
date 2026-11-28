import { afterEach, describe, expect, it } from 'vitest'
import { RouteLoader } from '../../src/core/data/route-loader'
import { MemoryStore } from '../../src/core/data/store'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('RouteLoader with the default fetch', () => {
  it('calls the global fetch without losing its receiver', async () => {
    const urls: string[] = []
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
      // Browsers throw "Illegal invocation" when fetch is called on an object other than window.
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      urls.push(String(input))
      return Promise.resolve(new Response('{"elements":[]}', { status: 200 }))
    } as typeof fetch

    const loader = new RouteLoader('https://api.example.test', { store: new MemoryStore(10) })
    const result = await loader.load(
      { south: -22.92, west: -43.18, north: -22.9, east: -43.16 },
      new AbortController().signal,
    )

    expect(result.failures).toEqual([])
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toContain('https://api.example.test/api/0.6/map.json?bbox=')
  })
})
