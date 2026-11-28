import { resolveColour } from './colour'
import { groupLines } from './lines'

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

const MODE_LABELS: Record<string, string> = {
  subway: 'Metro',
  light_rail: 'Light rail',
  tram: 'Tram',
  train: 'Train',
  bus: 'Bus',
  ferry: 'Ferry',
  monorail: 'Monorail',
}

/** A short name for the mode of a route, from its route tag. Unknown modes show the tag itself. */
export function modeLabel(route: RouteSource): string {
  const mode = route.tags.route ?? ''
  return MODE_LABELS[mode] ?? mode
}

/** The middle vertex of the longest line of a route, where its badge is drawn. */
function badgePoint(route: RouteSource): [number, number] | null {
  let longest: [number, number][] | undefined
  for (const line of route.lines) if (!longest || line.length > longest.length) longest = line
  if (!longest || longest.length === 0) return null
  return longest[Math.floor(longest.length / 2)]
}

/** One round badge per line, carrying its ref, in the line's colour. */
export function badgesToGeoJSON(routes: readonly RouteSource[]): PointCollection {
  return {
    type: 'FeatureCollection',
    features: groupLines(routes).flatMap((group) => {
      const point = badgePoint({ id: 0, tags: {}, lines: group.flatMap((route) => route.lines) })
      if (!point) return []
      const { colour } = resolveColour(group[0].tags.colour)
      return [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: point },
          properties: { ref: group[0].tags.ref ?? '', colour, textColour: contrastText(colour), mode: modeLabel(group[0]) },
        },
      ]
    }),
  }
}

/** Distance between two parallel tracks in the zoomed-out view, in pixels. Lines are 3 px wide. */
export const PARALLEL_SPACING = 4

export interface OverviewFeature {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: [number, number][] }
  properties: RouteProperties & {
    /** Pixels to move the segment sideways, so lines sharing a track sit side by side. */
    offset: number
  }
}

export interface OverviewCollection {
  type: 'FeatureCollection'
  features: OverviewFeature[]
}

/** Length in degrees, with longitude scaled by the cosine of the latitude. Only compared, never shown. */
function lineLength(line: readonly [number, number][]): number {
  let total = 0
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]
    const [x1, y1] = line[i]
    const cos = Math.cos(((y0 + y1) / 2) * (Math.PI / 180))
    total += Math.hypot((x1 - x0) * cos, y1 - y0)
  }
  return total
}

/**
 * The one route that draws a line in the zoomed-out view: the longest of its routes, the lowest id on a tie.
 * Its branches and the other direction's variants are left out, so each line is drawn once.
 */
export function mainRoute(group: readonly RouteSource[]): RouteSource | undefined {
  let best: RouteSource | undefined
  let bestLength = -1
  for (const route of group) {
    const length = route.lines.reduce((sum, line) => sum + lineLength(line), 0)
    if (length > bestLength) {
      best = route
      bestLength = length
    }
  }
  return best
}

/** True when a segment runs against the reference segment, so it must be drawn reversed to match. */
function isReversed(line: readonly [number, number][], reference: readonly [number, number][]): boolean {
  const d = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  const first = line[0]
  const last = line[line.length - 1]
  const refFirst = reference[0]
  const refLast = reference[reference.length - 1]
  return d(first, refFirst) + d(last, refLast) > d(first, refLast) + d(last, refFirst)
}

/**
 * One LineString per way of each line's main route, for the zoomed-out view. A way shared by several
 * lines is drawn once per line, each offset sideways from the track so the lines run side by side.
 * The offset is 0 for a way that only one line uses, and for routes saved without way ids.
 */
export function linesToGeoJSON(routes: readonly RouteSource[]): OverviewCollection {
  const mains: { route: RouteSource; group: RouteSource[] }[] = []
  for (const group of groupLines(routes)) {
    const route = mainRoute(group)
    if (route && route.lines.length > 0) mains.push({ route, group })
  }

  // The lines using each way, in the order of the groups, and the orientation of the first use.
  const users = new Map<number, number[]>()
  const reference = new Map<number, [number, number][]>()
  mains.forEach(({ route }, index) => {
    route.lines.forEach((line, at) => {
      const way = route.ways?.[at]
      if (way === undefined || line.length < 2) return
      const list = users.get(way) ?? []
      if (!list.includes(index)) list.push(index)
      users.set(way, list)
      if (!reference.has(way)) reference.set(way, line)
    })
  })

  const features: OverviewFeature[] = []
  mains.forEach(({ route, group }, index) => {
    const first = group[0]
    const { colour, valid } = resolveColour(first.tags.colour)
    route.lines.forEach((line, at) => {
      if (line.length < 2) return
      const way = route.ways?.[at]
      let offset = 0
      let coordinates = line
      if (way !== undefined) {
        const sharing = users.get(way) ?? [index]
        offset = (sharing.indexOf(index) - (sharing.length - 1) / 2) * PARALLEL_SPACING
        const ref = reference.get(way)
        if (ref && isReversed(line, ref)) coordinates = [...line].reverse()
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          relationId: first.id,
          ref: first.tags.ref ?? '',
          name: first.tags.name ?? '',
          operator: first.tags.operator ?? '',
          colour,
          colourValid: valid,
          offset,
        },
      })
    })
  })
  return { type: 'FeatureCollection', features }
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
