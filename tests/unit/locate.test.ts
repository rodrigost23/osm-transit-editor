import { describe, expect, it } from 'vitest'
import { LOCATE_ZOOM, locateErrorMessage } from '@/core/map/locate'

describe('locate me', () => {
  it('centres at zoom 14, where lines load', () => {
    expect(LOCATE_ZOOM).toBe(14)
  })

  it('words each geolocation error code', () => {
    expect(locateErrorMessage(1)).toBe('Location permission was denied.')
    expect(locateErrorMessage(2)).toBe('Your position is unavailable.')
    expect(locateErrorMessage(3)).toBe('Timed out while getting your position.')
    expect(locateErrorMessage(9)).toBe('Could not get your position.')
  })
})
