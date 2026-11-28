import { describe, expect, it } from 'vitest'
import { badgesToGeoJSON, contrastText, stopsToGeoJSON, type RouteSource } from '@/core/data/geojson'
import { parseOsmJson } from '@/core/data/osm-json'
import { relationRoute } from '@/core/data/route-loader'

const stop = { key: 'n1', name: 'Carioca', lat: -22.9, lon: -43.18 }

describe('relationRoute stops', () => {
  it('keeps stop nodes and platform ways as points, and ignores other members', () => {
    const data = parseOsmJson(
      JSON.stringify({
        elements: [
          { type: 'node', id: 1, lat: -22.9, lon: -43.18, tags: { name: 'Carioca' } },
          { type: 'node', id: 2, lat: 0, lon: 0 },
          { type: 'node', id: 3, lat: NaN, lon: 0 },
          { type: 'node', id: 4, lat: -22.8, lon: -43.1 },
          { type: 'node', id: 5, lat: -22.8, lon: -43.3 },
          { type: 'way', id: 10, nodes: [4, 5], tags: { railway: 'platform', name: 'Plat' } },
          { type: 'way', id: 11, nodes: [4, 5], tags: { railway: 'rail' } },
          { type: 'way', id: 12, nodes: [99], tags: { railway: 'platform' } },
          {
            type: 'relation',
            id: 7,
            tags: { ref: '1' },
            members: [
              { type: 'node', ref: 1, role: 'stop' },
              { type: 'node', ref: 3, role: 'stop_entry_only' },
              { type: 'node', ref: 2, role: 'stop_exit_only' },
              { type: 'node', ref: 999, role: 'stop' },
              { type: 'way', ref: 10, role: 'platform' },
              { type: 'way', ref: 12, role: 'platform' },
              { type: 'node', ref: 4, role: 'label' },
              { type: 'way', ref: 11, role: '' },
            ],
          },
        ],
      }),
    )
    const route = relationRoute(data, 7)
    expect(route.stops).toEqual([
      stop,
      { key: 'n2', name: '', lat: 0, lon: 0 },
      { key: 'w10', name: 'Plat', lat: -22.8, lon: -43.2 },
    ])
    expect(route.lines).toEqual([[[-43.1, -22.8], [-43.3, -22.8]]])
  })
})

describe('stopsToGeoJSON', () => {
  const route = (id: number, colour: string, stops?: RouteSource['stops']): RouteSource => ({
    id,
    tags: { colour },
    lines: [],
    stops,
  })

  it('draws a shared stop once, in the colour of the lowest route id', () => {
    const collection = stopsToGeoJSON([route(9, '#00aa00', [stop]), route(3, '#ff0000', [stop, { ...stop, key: 'n2' }])])
    expect(collection.features.map((feature) => feature.properties)).toEqual([
      { name: 'Carioca', colour: '#ff0000' },
      { name: 'Carioca', colour: '#ff0000' },
    ])
    expect(collection.features[0].geometry).toEqual({ type: 'Point', coordinates: [-43.18, -22.9] })
  })

  it('treats routes saved without stops as having none', () => {
    expect(stopsToGeoJSON([route(1, '#fff')]).features).toEqual([])
  })
})

describe('badgesToGeoJSON', () => {
  it('puts a badge on the middle vertex of the longest line, with readable text', () => {
    const collection = badgesToGeoJSON([
      {
        id: 1,
        tags: { ref: '1', colour: '#ffffff' },
        lines: [
          [[0, 0], [1, 1]],
          [[5, 5], [6, 6], [7, 7]],
        ],
      },
      { id: 2, tags: { ref: '2' }, lines: [] },
    ])
    expect(collection.features).toHaveLength(1)
    expect(collection.features[0].geometry.coordinates).toEqual([6, 6])
    expect(collection.features[0].properties).toEqual({ ref: '1', colour: '#ffffff', textColour: '#000000' })
  })
})

describe('contrastText', () => {
  it('picks black on light colours and white on dark ones, with short hex too', () => {
    expect(contrastText('#f58220')).toBe('#000000')
    expect(contrastText('#1e3a8a')).toBe('#ffffff')
    expect(contrastText('#fff')).toBe('#000000')
    expect(contrastText('#000')).toBe('#ffffff')
  })
})
