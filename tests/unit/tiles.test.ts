import { describe, expect, it } from 'vitest'
import { splitBox, tileBox, tilesCovering } from '@/core/data/tiles'

describe('tiles', () => {
  it('gives the bounds of a zoom 14 tile over central Rio', () => {
    const box = tileBox({ x: 6226, y: 9263, z: 14 })
    expect(box.west).toBeCloseTo(-43.198242, 5)
    expect(box.east).toBeCloseTo(-43.17627, 5)
    expect(box.south).toBeCloseTo(-22.917923, 5)
    expect(box.north).toBeCloseTo(-22.897683, 5)
  })

  it('finds the tile that holds a point inside the box', () => {
    const tile = tileBox({ x: 6226, y: 9263, z: 14 })
    const inner = { south: tile.south + 0.001, north: tile.north - 0.001, west: tile.west + 0.001, east: tile.east - 0.001 }
    expect(tilesCovering(inner)).toEqual([{ x: 6226, y: 9263, z: 14 }])
  })

  it('covers a box that spans two tiles in each direction with four tiles', () => {
    const first = tileBox({ x: 6226, y: 9263, z: 14 })
    const second = tileBox({ x: 6227, y: 9264, z: 14 })
    const box = {
      south: second.south + 0.001,
      north: first.north - 0.001,
      west: first.west + 0.001,
      east: second.east - 0.001,
    }
    expect(tilesCovering(box)).toHaveLength(4)
  })

  it('splits a box into four quarters that cover it', () => {
    const parts = splitBox({ south: 0, north: 2, west: 0, east: 4 })
    expect(parts).toHaveLength(4)
    expect(parts).toContainEqual({ south: 1, north: 2, west: 2, east: 4 })
    expect(parts).toContainEqual({ south: 0, north: 1, west: 0, east: 2 })
  })
})
