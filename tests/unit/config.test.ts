import { describe, expect, it } from 'vitest'
import { config } from '@/core/config'

describe('config', () => {
  it('opens on the world map, below the minimum line zoom', () => {
    expect(config.initialView.zoom).toBeLessThan(config.minLineZoom)
  })

  it('uses HTTPS endpoints', () => {
    for (const url of [config.osmApiUrl, config.nominatimUrl]) {
      expect(url).toMatch(/^https:\/\//)
    }
  })
})
