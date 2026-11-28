import { describe, expect, it } from 'vitest'
import { resolveColour } from '@/core/data/colour'
import { RouteChangeTracker, routesToGeoJSON, type RouteSource } from '@/core/data/geojson'

describe('resolveColour', () => {
  it('keeps valid hex colours', () => {
    expect(resolveColour('#00aa00')).toEqual({ colour: '#00aa00', valid: true })
    expect(resolveColour('#fff')).toEqual({ colour: '#fff', valid: true })
  })

  it('falls back to grey for missing, named or malformed colours', () => {
    expect(resolveColour(undefined)).toEqual({ colour: '#8a8a8a', valid: false })
    expect(resolveColour('green')).toEqual({ colour: '#8a8a8a', valid: false })
    expect(resolveColour('#12')).toEqual({ colour: '#8a8a8a', valid: false })
  })
})

describe('routesToGeoJSON', () => {
  const route: RouteSource = {
    id: 7944060,
    tags: { ref: '1', name: 'Metrô Rio Linha 1', operator: 'Metrô Rio', colour: '#f58220' },
    lines: [
      [
        [-43.2, -22.9],
        [-43.21, -22.91],
      ],
    ],
  }

  it('makes one MultiLineString per route', () => {
    const collection = routesToGeoJSON([route])
    expect(collection.features).toHaveLength(1)
    expect(collection.features[0].geometry).toEqual({ type: 'MultiLineString', coordinates: route.lines })
  })

  it('copies the tags into properties and marks the colour as valid', () => {
    expect(routesToGeoJSON([route]).features[0].properties).toEqual({
      relationId: 7944060,
      lineKey: '1||Metrô Rio',
      ref: '1',
      name: 'Metrô Rio Linha 1',
      operator: 'Metrô Rio',
      colour: '#f58220',
      colourValid: true,
    })
  })

  it('uses empty strings and grey when tags are missing, and skips routes without lines', () => {
    const collection = routesToGeoJSON([
      { id: 3, tags: {}, lines: [[[0, 0], [1, 1]]] },
      { id: 4, tags: {}, lines: [] },
    ])
    expect(collection.features).toHaveLength(1)
    expect(collection.features[0].properties).toMatchObject({ ref: '', name: '', operator: '', colour: '#8a8a8a', colourValid: false })
  })
})

describe('RouteChangeTracker', () => {
  const route = (id: number): RouteSource => ({ id, tags: {}, lines: [[[0, 0], [1, 1]]] })

  it('draws routes in id order and skips a set it has already drawn', () => {
    const tracker = new RouteChangeTracker()
    expect(tracker.next([route(9), route(3)])?.features.map((feature) => feature.id)).toEqual([3, 9])
    expect(tracker.next([route(3), route(9)])).toBeNull()
  })

  it('draws again when a route is added, and after a reset', () => {
    const tracker = new RouteChangeTracker()
    tracker.next([route(3)])
    expect(tracker.next([route(3), route(4)])).not.toBeNull()
    tracker.reset()
    expect(tracker.next([route(3), route(4)])).not.toBeNull()
  })
})
