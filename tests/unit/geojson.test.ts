import { describe, expect, it } from 'vitest'
import { resolveColour } from '@/core/data/colour'
import { routesToGeoJSON } from '@/core/data/geojson'
import type { OverpassResponse } from '@/core/data/overpass'

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
  const response: OverpassResponse = {
    elements: [
      {
        type: 'relation' as const,
        id: 7944060,
        tags: { ref: '1', name: 'Metrô Rio Linha 1', operator: 'Metrô Rio', colour: '#f58220' },
        members: [
          { type: 'node', ref: 1, role: 'stop' },
          {
            type: 'way',
            ref: 10,
            role: '',
            geometry: [
              { lat: -22.9, lon: -43.2 },
              { lat: -22.91, lon: -43.21 },
            ],
          },
          { type: 'way', ref: 11, role: '', geometry: [{ lat: -22.91, lon: -43.21 }] },
        ],
      },
      { type: 'relation', id: 2, tags: { route: 'subway' }, members: [] },
    ],
  }

  it('makes one MultiLineString per route with ways that have geometry', () => {
    const collection = routesToGeoJSON(response)
    expect(collection.features).toHaveLength(1)
    const [feature] = collection.features
    expect(feature.geometry.type).toBe('MultiLineString')
    expect(feature.geometry.coordinates).toEqual([
      [
        [-43.2, -22.9],
        [-43.21, -22.91],
      ],
    ])
  })

  it('copies the tags into properties and marks the colour as valid', () => {
    const [feature] = routesToGeoJSON(response).features
    expect(feature.properties).toEqual({
      relationId: 7944060,
      ref: '1',
      name: 'Metrô Rio Linha 1',
      operator: 'Metrô Rio',
      colour: '#f58220',
      colourValid: true,
    })
  })

  it('uses empty strings and grey when tags are missing', () => {
    const [feature] = routesToGeoJSON({
      elements: [
        {
          type: 'relation',
          id: 3,
          members: [{ type: 'way', ref: 1, role: '', geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }],
        },
      ],
    }).features
    expect(feature.properties).toMatchObject({ ref: '', name: '', operator: '', colour: '#8a8a8a', colourValid: false })
  })
})
