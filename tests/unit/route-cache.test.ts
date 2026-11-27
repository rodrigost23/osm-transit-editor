import { describe, expect, it } from 'vitest'
import { gridToBox, RouteCache, snapToGrid } from '@/core/data/route-cache'

const response = { elements: [] }

describe('snapToGrid', () => {
  it('snaps outward to a 0.1 degree grid', () => {
    expect(snapToGrid({ south: -22.93, west: -43.27, north: -22.85, east: -43.15 })).toEqual({
      south: -230,
      west: -433,
      north: -228,
      east: -431,
    })
  })

  it('converts back to degrees', () => {
    expect(gridToBox({ south: -230, west: -433, north: -228, east: -431 })).toEqual({
      south: -23,
      west: -43.3,
      north: -22.8,
      east: -43.1,
    })
  })
})

describe('RouteCache', () => {
  it('answers a box that lies inside a stored one', () => {
    const cache = new RouteCache()
    cache.store({ south: -230, west: -433, north: -220, east: -420 }, response)
    expect(cache.find({ south: -225, west: -430, north: -222, east: -425 })).toBe(response)
  })

  it('misses a box that reaches outside the stored one', () => {
    const cache = new RouteCache()
    cache.store({ south: -230, west: -433, north: -220, east: -420 }, response)
    expect(cache.find({ south: -231, west: -430, north: -222, east: -425 })).toBeUndefined()
  })

  it('forgets the oldest entries past its limit', () => {
    const cache = new RouteCache()
    cache.store({ south: 0, west: 0, north: 1, east: 1 }, { elements: [{ type: 'relation', id: 0 }] })
    for (let i = 1; i <= 8; i++) cache.store({ south: i, west: i, north: i + 1, east: i + 1 }, response)
    expect(cache.find({ south: 0, west: 0, north: 1, east: 1 })).toBeUndefined()
  })
})
