import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from '@/core/map/position'

describe('map position in the hash', () => {
  it('reads the iD form zoom/lat/lon', () => {
    expect(parseHash('#map=12.50/-22.90350/-43.18000')).toEqual({
      zoom: 12.5,
      lat: -22.9035,
      lon: -43.18,
    })
  })

  it('accepts a hash without the leading #', () => {
    expect(parseHash('map=3/10/20')).toEqual({ zoom: 3, lat: 10, lon: 20 })
  })

  it('rejects other forms and out-of-range values', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#/map/1/2/3')).toBeNull()
    expect(parseHash('#map=30/0/0')).toBeNull()
    expect(parseHash('#map=5/90/0')).toBeNull()
    expect(parseHash('#map=5/0/200')).toBeNull()
  })

  it('writes rounded values and reads them back', () => {
    const hash = formatHash({ zoom: 12.345, lat: -22.90349999, lon: -43.1800012 })
    expect(hash).toBe('#map=12.35/-22.90350/-43.18000')
    expect(parseHash(hash)).toEqual({ zoom: 12.35, lat: -22.9035, lon: -43.18 })
  })
})
