import { describe, expect, it } from 'vitest'
import { badgesToGeoJSON, contrastText, linesToGeoJSON, modeLabel, sharedStationsToGeoJSON, stopsToGeoJSON, type RouteSource } from '@/core/data/geojson'
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

  it('draws one dot per stop, in the colour of the lowest route id, and names a station once', () => {
    const collection = stopsToGeoJSON([
      route(9, '#00aa00', [stop]),
      route(3, '#ff0000', [stop, { ...stop, key: 'n2', lat: -22.91, lon: -43.19 }, { ...stop, key: 'n3', name: 'Uruguai' }]),
    ])
    expect(collection.features.map((feature) => feature.properties)).toEqual([
      { name: 'Carioca', label: 'Carioca', primary: 'true', colour: '#ff0000', lines: ['||'] },
      { name: 'Carioca', label: '', primary: 'false', colour: '#ff0000', lines: ['||'] },
      { name: 'Uruguai', label: 'Uruguai', primary: 'true', colour: '#ff0000', lines: ['||'] },
    ])
    expect(collection.features[0].geometry).toEqual({ type: 'Point', coordinates: [-43.18, -22.9] })
    expect(collection.features[1].geometry).toEqual({ type: 'Point', coordinates: [-43.19, -22.91] })
  })

  it('draws a stop shared by parallel ways once, and keeps the second way of a station', () => {
    const forward = { ...stop, key: 'n10' }
    const backward = { ...stop, key: 'n11', lat: -22.901, lon: -43.181 }
    const collection = stopsToGeoJSON([route(1, '#fff', [forward]), route(2, '#fff', [backward, { ...stop, key: 'n10' }])])
    expect(collection.features).toHaveLength(2)
    expect(collection.features.map((feature) => feature.properties.primary)).toEqual(['true', 'false'])
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
    expect(collection.features[0].properties).toEqual({ ref: '1', lineKey: '1||', colour: '#ffffff', textColour: '#000000', mode: '' })
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

  it('keeps a line in the same lane when it leaves the shared track', () => {
    const red: RouteSource = { id: 1, tags: { ref: 'R' }, lines: [[[0, 0], [1, 0]], [[1, 0], [2, 0]]], ways: [100, 200] }
    const green: RouteSource = { id: 2, tags: { ref: 'G' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const collection = linesToGeoJSON([green, red])
    expect(collection.features.map((feature) => feature.properties.offset)).toEqual([-2, -2, 2])
  })

  it('spreads three lines on one track evenly', () => {
    const routes = [1, 2, 3].map((id): RouteSource => ({ id, tags: { ref: String(id) }, lines: [[[0, 0], [1, 0]]], ways: [100] }))
    expect(linesToGeoJSON(routes).features.map((feature) => feature.properties.offset)).toEqual([-4, 0, 4])
  })

  it('draws a shared track in one direction for every line, whichever way each route runs', () => {
    const north: RouteSource = { id: 1, tags: { ref: 'N' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const south: RouteSource = { id: 2, tags: { ref: 'S' }, lines: [[[1, 0], [0, 0]]], ways: [100] }
    const coordinates = linesToGeoJSON([north, south]).features.map((feature) => feature.geometry.coordinates)
    // Both run west to east; the lane offset moves them off the centre line, but not their direction.
    for (const line of coordinates) {
      expect(line[0][0]).toBeCloseTo(0, 6)
      expect(line[line.length - 1][0]).toBeCloseTo(1, 6)
    }
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

describe('sharedStationsToGeoJSON', () => {
  it('lists only stations served by two or more lines, with the colour of each', () => {
    const red: RouteSource = {
      id: 1,
      tags: { ref: 'R', colour: '#ff0000' },
      lines: [[[0, 0], [1, 0]]],
      ways: [100],
      stops: [
        { key: 'n1', name: 'Shared', lat: 0, lon: 0.5 },
        { key: 'n2', name: 'Alone', lat: 0, lon: 0.9 },
      ],
    }
    const green: RouteSource = {
      id: 2,
      tags: { ref: 'G', colour: '#00ff00' },
      lines: [[[0, 0], [1, 0]]],
      ways: [100],
      stops: [{ key: 'n3', name: 'Shared', lat: 0, lon: 0.5 }],
    }
    const collection = sharedStationsToGeoJSON([red, green])
    expect(collection.features).toHaveLength(1)
    expect(collection.features[0].geometry.coordinates).toEqual([0.5, 0])
    expect(collection.features[0].properties.colourA).toBe('#ff0000')
    expect(collection.features[0].properties.colourB).toBe('#00ff00')
    // An east-west track: the shape lies north-south, a quarter turn from the track.
    expect(collection.features[0].properties.angle).toBeCloseTo(90)
  })
})

describe('lane order in a bundle', () => {
  it('gives the left lane to the line that leaves the track on the left', () => {
    // Travelling east on way 100. Route 1 turns south-east (right), route 2 turns north-east (left).
    const right: RouteSource = { id: 1, tags: { ref: 'R' }, lines: [[[0, 0], [2, 0]], [[2, 0], [3, -1]]], ways: [100, 300] }
    const left: RouteSource = { id: 2, tags: { ref: 'L' }, lines: [[[0, 0], [2, 0]], [[2, 0], [3, 1]]], ways: [100, 200] }
    const offsets = linesToGeoJSON([right, left]).features.map((feature) => feature.properties.offset)
    expect(offsets).toEqual([2, 2, -2, -2])
  })
})

describe('stopsToGeoJSON with lanes', () => {
  it('moves a station of one line onto its lane below zoom 14, and leaves it at zoom 14', () => {
    const a: RouteSource = { id: 1, tags: { ref: 'A' }, lines: [[[0, 0], [1, 0]]], ways: [100], stops: [{ key: 'n1', name: 'Solo', lat: 0, lon: 0.5 }] }
    const b: RouteSource = { id: 2, tags: { ref: 'B' }, lines: [[[0, 0], [1, 0]]], ways: [100] }
    const zoomed = stopsToGeoJSON([a, b], 12).features[0].geometry.coordinates
    expect(zoomed[0]).toBeCloseTo(0.5)
    expect(Math.abs(zoomed[1])).toBeGreaterThan(0)
    expect(stopsToGeoJSON([a, b], 14).features[0].geometry.coordinates).toEqual([0.5, 0])
  })
})

describe('stations with a direction in their name', () => {
  it('draws the two stop positions of one station once, as the same station', () => {
    const route = (id: number, name: string, key: string): RouteSource => ({
      id,
      tags: { ref: String(id) },
      lines: [[[0, 0], [1, 0]]],
      ways: [100 + id],
      stops: [{ key, name, lat: 0, lon: 0.5 }],
    })
    const sharing = [
      route(1, 'Cardeal Arcoverde - Sentido Uruguai', 'n1'),
      route(2, 'Cardeal Arcoverde - Sentido Gen. Osório / Jd. Oceânico', 'n2'),
    ]
    expect(stopsToGeoJSON(sharing).features.map((feature) => feature.properties.label)).toEqual(['Cardeal Arcoverde', ''])
    expect(sharedStationsToGeoJSON(sharing).features).toHaveLength(1)
  })
})

describe('station shift follows its own line', () => {
  it('uses the track of the station\'s line, not a crossing track nearby', () => {
    // Line A runs east on way 100. Line B crosses it going north at the same station, and is drawn in its own bundle.
    const a: RouteSource = { id: 1, tags: { ref: 'A' }, lines: [[[0, 0], [1, 0]]], ways: [100], stops: [{ key: 'n1', name: 'Crossing', lat: 0, lon: 0.5 }] }
    const b: RouteSource = { id: 2, tags: { ref: 'B' }, lines: [[[0.5, -1], [0.5, 0], [0.5, 1]]], ways: [200] }
    const shifted = stopsToGeoJSON([a, b], 12).features[0].geometry.coordinates
    // Along line A, the shift is only north-south: the longitude stays where the station is.
    expect(shifted[0]).toBeCloseTo(0.5, 6)
  })
})

describe('station shape orientation', () => {
  it('turns the same way when a line traverses the track the other way round', () => {
    const forward: RouteSource = { id: 1, tags: { ref: 'F', colour: '#ff0000' }, lines: [[[0, 0], [1, 0]]], ways: [100], stops: [{ key: 'n1', name: 'Joint', lat: 0, lon: 0.5 }] }
    const backward: RouteSource = { id: 2, tags: { ref: 'K', colour: '#00ff00' }, lines: [[[1, 0], [0, 0]]], ways: [100], stops: [{ key: 'n2', name: 'Joint', lat: 0, lon: 0.5 }] }
    const [station] = sharedStationsToGeoJSON([forward, backward]).features
    expect(station.properties.angle).toBeCloseTo(90)
  })
})

describe('station on its lane', () => {
  it('sits on the drawn lane, the lane offset away from the centre of a bent track', () => {
    const bent = [[0, 0], [1, 0], [2, 1]] as [number, number][]
    const a: RouteSource = { id: 1, tags: { ref: 'A' }, lines: [bent], ways: [100], stops: [{ key: 'n1', name: 'Bend', lat: 0, lon: 1 }] }
    const b: RouteSource = { id: 2, tags: { ref: 'B' }, lines: [bent], ways: [100] }
    const [lon, lat] = stopsToGeoJSON([a, b], 12).features[0].geometry.coordinates
    // Two pixels from the centre of the track, measured on the bend's normal at the station.
    const pixel = 360 / (512 * 2 ** 12)
    const distance = Math.hypot(lon - 1, lat - 0)
    expect(distance).toBeCloseTo(2 * pixel, 6)
  })
})

describe('station shape follows the lanes near a bend', () => {
  it('puts the line drawn north of the track in the left half, when the lines bend apart after the station', () => {
    // Both lines run east on way 100. Red leaves the track to the north-east, green to the south-east.
    const red: RouteSource = {
      id: 1,
      tags: { ref: 'R', colour: '#ff0000' },
      lines: [[[0, 0], [1, 0], [2, 1]]],
      ways: [100],
      stops: [{ key: 'n1', name: 'Bend', lat: 0, lon: 0.5 }],
    }
    const green: RouteSource = {
      id: 2,
      tags: { ref: 'G', colour: '#00ff00' },
      lines: [[[0, 0], [1, 0], [2, -1]]],
      ways: [100],
      stops: [{ key: 'n2', name: 'Bend', lat: 0, lon: 0.5 }],
    }
    const dots = stopsToGeoJSON([red, green], 12).features
    const northern = dots.reduce((a, b) => (b.geometry.coordinates[1] > a.geometry.coordinates[1] ? b : a))
    const northColour = northern.properties.colour
    const [station] = sharedStationsToGeoJSON([red, green], 12).features
    expect(station.properties.colourA).toBe(northColour)
    expect(station.properties.colourB).not.toBe(northColour)
  })
})

describe('shape centred between the lanes of its lines', () => {
  it('sits midway between the two lane dots, whichever way the track runs', () => {
    const red: RouteSource = { id: 1, tags: { ref: 'R', colour: '#ff0000' }, lines: [[[0, 0], [1, 0]]], ways: [100], stops: [{ key: 'n1', name: 'Mid', lat: 0, lon: 0.5 }] }
    const green: RouteSource = { id: 2, tags: { ref: 'G', colour: '#00ff00' }, lines: [[[1, 0], [0, 0]]], ways: [100], stops: [{ key: 'n2', name: 'Mid', lat: 0, lon: 0.5 }] }
    const dots = stopsToGeoJSON([red, green], 12).features.map((feature) => feature.geometry.coordinates)
    const [station] = sharedStationsToGeoJSON([red, green], 12).features
    const mid = [0, 1].map((axis) => (dots[0][axis] + dots[1][axis]) / 2)
    expect(station.geometry.coordinates[0]).toBeCloseTo(mid[0], 9)
    expect(station.geometry.coordinates[1]).toBeCloseTo(mid[1], 9)
  })
})

describe('a turned way keeps the side of the corridor', () => {
  it('puts the green line on the same side on both ways of the junction at Botafogo', () => {
    // Real ways near Botafogo (OSM ids). Way 1185925992 is shared by both lines, drawn south; way 1075230314
    // is only on green and joins it at the same node, so it is turned to continue the shared way.
    const shared: [number, number][] = [[-43.1785326, -22.9371994], [-43.1842755, -22.9493353]]
    const turned: [number, number][] = [[-43.1841716, -22.9503612], [-43.1842755, -22.9493353]]
    const orange: RouteSource = {
      id: 1,
      tags: { ref: '1', colour: '#e77405' },
      lines: [shared, [[-43.1842755, -22.9493353], [-43.1841716, -22.9503612]]],
      ways: [1185925992, 1067026431],
    }
    const green: RouteSource = {
      id: 2,
      tags: { ref: '2', colour: '#028f34' },
      lines: [shared, turned],
      ways: [1185925992, 1075230314],
    }
    const features = linesToGeoJSON([orange, green], 13).features.filter((feature) => feature.properties.ref === '2')
    expect(features).toHaveLength(2)
    // Compare the sideways shift of a point far from the junction on each green way, so the junction's shared
    // miter cannot decide the result: both points must move to the same side of the track.
    const shiftOf = (original: [number, number]) => {
      const drawn = features.flatMap((feature) => feature.geometry.coordinates as [number, number][])
      let best = drawn[0]
      for (const point of drawn) {
        if (Math.hypot(point[0] - original[0], point[1] - original[1]) < Math.hypot(best[0] - original[0], best[1] - original[1])) best = point
      }
      return Math.sign(best[0] - original[0])
    }
    const sideShared = shiftOf(shared[0])
    const sideTurned = shiftOf(turned[0])
    expect(sideShared).not.toBe(0)
    expect(sideTurned).toBe(sideShared)
  })
})
