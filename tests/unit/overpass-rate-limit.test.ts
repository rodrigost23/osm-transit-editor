import { describe, expect, it, vi } from 'vitest'
import { fetchSubwayRoutes, type FetchLike } from '@/core/data/overpass'

const box = { south: -23, west: -43.3, north: -22.8, east: -43.1 }
const json = { elements: [] }

describe('rate limiting', () => {
  it('waits for Retry-After before trying another server', async () => {
    const waits: number[] = []
    const fetchFn = vi.fn<FetchLike>(async (url) =>
      url === 'https://a.test'
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } })
        : new Response(JSON.stringify(json), { status: 200 }),
    )
    await fetchSubwayRoutes(['https://a.test', 'https://b.test'], box, {
      fetchFn,
      wait: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([3000, 3000])
    expect(fetchFn.mock.calls.at(-1)?.[0]).toBe('https://b.test')
  })

  it('names each failed server in the final error', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response('busy', { status: 503 }))
    await expect(
      fetchSubwayRoutes(['https://a.test'], box, { fetchFn, wait: async () => {} }),
    ).rejects.toThrow('a.test: 503')
  })
})
