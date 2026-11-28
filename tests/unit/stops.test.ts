import { describe, expect, it } from 'vitest'
import { badgesToGeoJSON, contrastText, linesToGeoJSON, modeLabel, stopsToGeoJSON, type RouteSource } from '@/core/data/geojson'
import { parseOsmJson } from '@/core/data/osm-json'
import { relationRoute } from '@/core/data/route-loader'

const stop = { key: 'n1', name: 'Carioca', lat: -22.9, lon: -43.18 }

describe('relationRoute stops', () => {
  it('keeps stop nodes only, not platforms, entrances or other members', () => {
    const data = parseOsmJson(
      JSON.stringify({
        elements: [
          { type: 'node', id: 1, lat: -22.9, lon: -43.18, tags: { name: 'Carioca' } },
          { type: 'node', id: 2, lat: -22.91, lon: -43.19, tags: { name: 'Carioca' } },
          { type: 'node', id: 3, lat: NaN, lon: 0 },
          { type: 'node', id: 4, lat: -22.8, lon: -43.1 },
          { type: 'node', id: 5, lat: -22.8, lon: -43.3 },
          { type: 'node', id: 6, lat: -22.85, lon: -43.2, tags: { railway: 'subway_entrance' } },
          { type: 'way', id: 10, nodes: [4, 5], tags: { railway: 'platform', name: 'Plat' } },
          { type: 'way', id: 11, nodes: [4, 5], tags: { railway: 'rail' } },
          {
            type: 'relation',
            id: 7,
            tags: { ref: '1' },
            members: [
              { type: 'node', ref: 1, role: 'stop' },
              { type: 'node', ref: 2, role: 'stop_exit_only' },
              { type: 'node', ref: 3, role: 'stop_entry_only' },
              { type: 'node', ref: 999, role: 'stop' },
              { type: 'node', ref: 6, role: 'subway_entrance' },
              { type: 'way', ref: 10, role: 'platform' },
              { type: 'node', ref: 4, role: 'label' },
              { type: 'way', ref: 11, role: '' },
            ],
          },
        ],
      }),
    )
    const route = relationRoute(data, 7)
    expect(route.stops).toEqual([stop, { key: 'n2', name: 'Carioca', lat: -22.91, lon: -43.19 }])
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

  it('draws a station once when several stops share its name, in the colour of the lowest route id', () => {
    const collection = stopsToGeoJSON([
      route(9, '#00aa00', [stop]),
      route(3, '#ff0000', [stop, { ...stop, key: 'n2', lat: -22.91, lon: -43.19 }, { ...stop, key: 'n3', name: 'Uruguai' }]),
    ])
    expect(collection.features.map((feature) => feature.properties)).toEqual([
      { name: 'Carioca', colour: '#ff0000' },
      { name: 'Uruguai', colour: '#ff0000' },
    ])
    expect(collection.features[0].geometry).toEqual({ type: 'Point', coordinates: [-43.18, -22.9] })
  })

  it('keeps unnamed stops apart by their node', () => {
    const collection = stopsToGeoJSON([route(1, '#fff', [{ ...stop, name: '', key: 'n5' }, { ...stop, name: '', key: 'n6' }])])
    expect(collection.features).toHaveLength(2)
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
    expect(collection.features[0].properties).toEqual({ ref: '1', colour: '#ffffff', textColour: '#000000', mode: '' })
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

describe('linesToGeoJSON', () => {
  const tags = { ref: '1', network: 'Metrô', operator: 'Metrô Rio', colour: '#f58220' }

  it('draws one line per line name, from its longest route, without the branches of the others', () => {
    const forward: RouteSource = { id: 5, tags, lines: [[[0, 0], [1, 1]], [[1, 1], [2, 2]]], ways: [100, 101] }
    // The other direction stops short and takes a side branch: only the longer route is drawn.
    const backward: RouteSource = { id: 6, tags, lines: [[[2, 2], [1, 1]], [[1, 1], [1.2, 0.2]]], ways: [101, 300] }
    const other: RouteSource = { id: 9, tags: { ref: '2' }, lines: [[[5, 5], [6, 6]]], ways: [200] }
    const collection = linesToGeoJSON([backward, forward, other])
    expect(collection.features.map((feature) => feature.geometry.coordinates)).toEqual([
      [[0, 0], [1, 1]],
      [[1, 1], [2, 2]],
      [[5, 5], [6, 6]],
    ])
    expect(collection.features[0].properties.colour).toBe('#f58220')
  })

  it('puts lines that share a track side by side, centred on it', () => {
    const red: RouteSource = { id: 1, tags: { ref: 'R' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const green: RouteSource = { id: 2, tags: { ref: 'G' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const alone: RouteSource = { id: 3, tags: { ref: 'A' }, lines: [[[0, 1], [1, 1]]], ways: [200] }
    const offsets = linesToGeoJSON([green, red, alone]).features.map((feature) => feature.properties.offset)
    expect(offsets).toEqual([-2, 2, 0])
  })

  it('spreads three lines on one track evenly', () => {
    const routes = [1, 2, 3].map((id): RouteSource => ({ id, tags: { ref: String(id) }, lines: [[[0, 0], [1, 0]]], ways: [100] }))
    expect(linesToGeoJSON(routes).features.map((feature) => feature.properties.offset)).toEqual([-4, 0, 4])
  })

  it('draws a shared track in one direction for every line, whichever way each route runs', () => {
    const north: RouteSource = { id: 1, tags: { ref: 'N' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const south: RouteSource = { id: 2, tags: { ref: 'S' }, lines: [[[1, 0], [0, 0]]], ways: [100] }
    const coordinates = linesToGeoJSON([north, south]).features.map((feature) => feature.geometry.coordinates)
    expect(coordinates).toEqual([
      [[0, 0], [1, 0]],
      [[0, 0], [1, 0]],
    ])
  })

  it('draws every line of routes saved without way ids, without offsets', () => {
    const first: RouteSource = { id: 1, tags: {}, lines: [[[0, 0], [1, 1]], [[1, 1], [2, 2]]] }
    const second: RouteSource = { id: 2, tags: { ref: 'x' }, lines: [[[5, 5], [6, 6]]] }
    const collection = linesToGeoJSON([first, second])
    expect(collection.features).toHaveLength(3)
    expect(collection.features.every((feature) => feature.properties.offset === 0)).toBe(true)
  })
})

describe('modeLabel', () => {
  it('names the mode from the route tag, and keeps unknown tags as they are', () => {
    expect(modeLabel({ id: 1, tags: { route: 'tram' }, lines: [] })).toBe('Tram')
    expect(modeLabel({ id: 2, tags: { route: 'subway' }, lines: [] })).toBe('Metro')
    expect(modeLabel({ id: 3, tags: { route: 'funicular' }, lines: [] })).toBe('funicular')
    expect(modeLabel({ id: 4, tags: {}, lines: [] })).toBe('')
  })
})
