import { resolveColour } from './colour'
import { lineKey } from './lines'

/** A station or platform of a route, as one point. */
export interface Stop {
  /** Same key for the same stop on every route that serves it: "n" + node id, or "w" + way id. */
  key: string
  name: string
  lat: number
  lon: number
}

/** A subway route, with its full line geometry as [lon, lat] pairs. */
export interface RouteSource {
  id: number
  tags: Record<string, string>
  lines: [number, number][][]
  /** The way of each line, in the same order as lines. Missing in data saved by older versions. */
  ways?: number[]
  /** Stations listed in the relation. Missing in data saved by older versions. */
  stops?: Stop[]
}

export interface PointFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: Record<string, string>
}

export interface PointCollection {
  type: 'FeatureCollection'
  features: PointFeature[]
}

export interface RouteProperties {
  relationId: number
  ref: string
  name: string
  operator: string
  colour: string
  colourValid: boolean
}

export interface RouteFeature {
  type: 'Feature'
  id: number
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] }
  properties: RouteProperties
}

export interface RouteCollection {
  type: 'FeatureCollection'
  features: RouteFeature[]
}

/** Remembers what was last drawn, so a set of routes that has not changed is not sent to the map again. */
export class RouteChangeTracker {
  private lastKey: string | undefined

  /** The collection to draw, or null when it holds the same routes as the last one drawn. */
  next(routes: readonly RouteSource[]): RouteCollection | null {
    const sorted = [...routes].sort((a, b) => a.id - b.id)
    const key = sorted.map((route) => route.id).join(',')
    if (key === this.lastKey) return null
    this.lastKey = key
    return routesToGeoJSON(sorted)
  }

  reset(): void {
    this.lastKey = undefined
  }
}

/**
 * One point per station. Stops with the same name are one station, drawn once, in the colour of the
 * first route (by id) that serves them. Unnamed stops are kept apart by their node.
 */
export function stopsToGeoJSON(routes: readonly RouteSource[]): PointCollection {
  const seen = new Set<string>()
  const features: PointFeature[] = []
  for (const route of [...routes].sort((a, b) => a.id - b.id)) {
    const { colour } = resolveColour(route.tags.colour)
    for (const stop of route.stops ?? []) {
      const identity = stop.name ? `name:${stop.name}` : stop.key
      if (seen.has(identity)) continue
      seen.add(identity)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        properties: { name: stop.name, colour },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Black or white, whichever reads better on a hex colour from resolveColour. */
export function contrastText(colour: string): '#000000' | '#ffffff' {
  const hex = colour.slice(1)
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16))
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff'
}

/** The middle vertex of the longest line of a route, where its badge is drawn. */
function badgePoint(route: RouteSource): [number, number] | null {
  let longest: [number, number][] | undefined
  for (const line of route.lines) if (!longest || line.length > longest.length) longest = line
  if (!longest || longest.length === 0) return null
  return longest[Math.floor(longest.length / 2)]
}

/** The routes of each line, in id order: one line per ref, network and operator. */
function groupByLine(routes: readonly RouteSource[]): RouteSource[][] {
  const groups = new Map<string, RouteSource[]>()
  for (const route of [...routes].sort((a, b) => a.id - b.id)) {
    const key = lineKey(route)
    groups.set(key, [...(groups.get(key) ?? []), route])
  }
  return [...groups.values()]
}

/** One round badge per line, carrying its ref, in the line's colour. */
export function badgesToGeoJSON(routes: readonly RouteSource[]): PointCollection {
  return {
    type: 'FeatureCollection',
    features: groupByLine(routes).flatMap((group) => {
      const point = badgePoint({ id: 0, tags: {}, lines: group.flatMap((route) => route.lines) })
      if (!point) return []
      const { colour } = resolveColour(group[0].tags.colour)
      return [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: point },
          properties: { ref: group[0].tags.ref ?? '', colour, textColour: contrastText(colour) },
        },
      ]
    }),
  }
}

/**
 * One MultiLineString per line, for the zoomed-out view. A way shared by the two directions
 * of a line is drawn once.
 */
export function linesToGeoJSON(routes: readonly RouteSource[]): RouteCollection {
  return {
    type: 'FeatureCollection',
    features: groupByLine(routes).flatMap((group) => {
      const seen = new Set<number>()
      const coordinates: [number, number][][] = []
      for (const route of group) {
        route.lines.forEach((line, index) => {
          const way = route.ways?.[index]
          if (way !== undefined) {
            if (seen.has(way)) return
            seen.add(way)
          }
          coordinates.push(line)
        })
      }
      if (coordinates.length === 0) return []
      const first = group[0]
      const { colour, valid } = resolveColour(first.tags.colour)
      return [
        {
          type: 'Feature' as const,
          id: first.id,
          geometry: { type: 'MultiLineString' as const, coordinates },
          properties: {
            relationId: first.id,
            ref: first.tags.ref ?? '',
            name: first.tags.name ?? '',
            operator: first.tags.operator ?? '',
            colour,
            colourValid: valid,
          },
        },
      ]
    }),
  }
}

/** One MultiLineString feature per route that has at least one line. */
export function routesToGeoJSON(routes: readonly RouteSource[]): RouteCollection {
  return {
    type: 'FeatureCollection',
    features: routes.flatMap((route) => {
      if (route.lines.length === 0) return []
      const { colour, valid } = resolveColour(route.tags.colour)
      return [
        {
          type: 'Feature' as const,
          id: route.id,
          geometry: { type: 'MultiLineString' as const, coordinates: route.lines },
          properties: {
            relationId: route.id,
            ref: route.tags.ref ?? '',
            name: route.tags.name ?? '',
            operator: route.tags.operator ?? '',
            colour,
            colourValid: valid,
          },
        },
      ]
    }),
  }
}
