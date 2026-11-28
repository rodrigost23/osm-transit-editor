import { resolveColour } from './colour'
import { groupLines, lineKey } from './lines'

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
 * One point per stop, in the colour of the first route (by id) that serves it. A stop shared by
 * several routes is drawn once. Each stop carries a `label` (its name, only on the first stop
 * with that name, so a station is named once) and `primary` (true only on that same first stop,
 * for the zoomed-out view, where one dot per station is enough).
 */
export function stopsToGeoJSON(routes: readonly RouteSource[], zoom?: number): PointCollection {
  const seenKeys = new Set<string>()
  const seenNames = new Set<string>()
  // Zoomed out, a station served by one line sits on that line's lane, not on the centre of the track.
  const offsets = zoom !== undefined && zoom < PARALLEL_MAX_ZOOM ? laneOffsets(routes) : undefined
  const reference = overviewLanes(routes).reference
  const linesAt = new Map<string, Set<string>>()
  for (const route of routes) {
    for (const stop of route.stops ?? []) {
      const identity = stop.name ? stationName(stop.name) : stop.key
      linesAt.set(identity, (linesAt.get(identity) ?? new Set()).add(lineKey(route)))
    }
  }
  const features: PointFeature[] = []
  for (const route of [...routes].sort((a, b) => a.id - b.id)) {
    const { colour } = resolveColour(route.tags.colour)
    for (const stop of route.stops ?? []) {
      if (seenKeys.has(stop.key)) continue
      seenKeys.add(stop.key)
      const name = stop.name ? stationName(stop.name) : ''
      const firstWithName = !name || !seenNames.has(name)
      if (name) seenNames.add(name)
      const offset = offsets?.get(route.id) ?? 0
      const single = linesAt.get(name || stop.key)?.size === 1
      const coordinates: [number, number] =
        offset !== 0 && single && zoom !== undefined
          ? laneAnchor(drawnRoutes(routes, route), [stop.lon, stop.lat], offset, zoom, reference)
          : [stop.lon, stop.lat]
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: {
          name,
          label: firstWithName ? name : '',
          primary: String(firstWithName),
          colour,
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * The name of a station, without the direction some stops carry, such as "Cardeal Arcoverde - Sentido
 * Uruguai". Stops of one station share the name, so they are drawn once.
 */
export function stationName(name: string): string {
  return name.replace(/\s+-\s+Sentido\b.*$/i, '').trim()
}

/** Below this zoom, lines are drawn side by side on their tracks, and stations move with their lane. */
const PARALLEL_MAX_ZOOM = 14

/** The route drawn for the line of a route in the zoomed-out view: its main route, the only one drawn. */
function drawnRoutes(routes: readonly RouteSource[], route: RouteSource): RouteSource[] {
  const group = groupLines(routes).find((members) => members.includes(route))
  const main = group ? mainRoute(group) : undefined
  return main ? [main] : []
}

/**
 * Where a single-line station sits on its lane: its nearest point on the drawn track, moved sideways by the
 * line's offset along that segment. This is the lane the map draws there, curves included.
 */
function laneAnchor(
  routes: readonly RouteSource[],
  point: [number, number],
  offset: number,
  zoom: number,
  reference: ReadonlyMap<number, [number, number][]>,
): [number, number] {
  const [lon, lat] = point
  const cos = Math.cos((lat * Math.PI) / 180)
  // Screen-proportional frame: x is longitude scaled by the cosine, y is latitude, negated (y points down).
  const project = ([x, y]: [number, number]): [number, number] => [x * cos, -y]
  const [px, py] = project([lon, lat])
  // Pixels to frame units, at this zoom: a 512 px world per 360 degrees of longitude.
  const unitsPerPixel = (360 / (512 * 2 ** zoom)) * cos
  let best: { distance: number; x: number; y: number; nx: number; ny: number } | undefined
  for (const route of routes) {
    route.lines.forEach((line, index) => {
      const way = route.ways?.[index]
      const ref = way !== undefined ? reference.get(way) : undefined
      // The line as drawn: reversed where the overview draws it against its way.
      const drawn = ref !== undefined && isReversed(line, ref) ? [...line].reverse() : line
      for (let at = 0; at + 1 < drawn.length; at++) {
        const [ax, ay] = project(drawn[at])
        const [bx, by] = project(drawn[at + 1])
        const dx = bx - ax
        const dy = by - ay
        const length2 = dx * dx + dy * dy
        if (length2 === 0) continue
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
        const x = ax + t * dx
        const y = ay + t * dy
        const distance = (px - x) ** 2 + (py - y) ** 2
        if (best && distance >= best.distance) continue
        const length = Math.sqrt(length2)
        // The right-hand side of the direction of travel, as a positive line-offset is drawn.
        best = { distance, x, y, nx: -dy / length, ny: dx / length }
      }
    })
  }
  if (!best) return point
  const side = offset * unitsPerPixel
  const x = best.x + best.nx * side
  const y = best.y + best.ny * side
  return [x / cos, -y]
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

/**
 * Which side a route leaves its shared track on, summed over the junctions where it leaves: +1 for each
 * junction on the left of the track's direction, -1 for each on the right. A junction is where a shared
 * segment meets a segment that is not shared, and the side is taken from where the next segment goes.
 */
function exitSide(
  route: RouteSource,
  isShared: (at: number) => boolean,
  reference: ReadonlyMap<number, [number, number][]>,
): number {
  const lines = route.lines
  const middle = (line: readonly [number, number][]): [number, number] => [
    (line[0][0] + line[line.length - 1][0]) / 2,
    (line[0][1] + line[line.length - 1][1]) / 2,
  ]
  let side = 0
  lines.forEach((line, at) => {
    const way = route.ways?.[at]
    if (line.length < 2 || way === undefined || !isShared(at)) return
    const ref = reference.get(way)
    if (!ref) return
    const track = [ref[ref.length - 1][0] - ref[0][0], ref[ref.length - 1][1] - ref[0][1]]
    for (const neighbour of [at - 1, at + 1]) {
      if (neighbour < 0 || neighbour >= lines.length || isShared(neighbour) || lines[neighbour].length < 2) continue
      const target = middle(lines[neighbour])
      const ends = [line[0], line[line.length - 1]]
      const junction = ends.reduce((best, point) =>
        (point[0] - target[0]) ** 2 + (point[1] - target[1]) ** 2 < (best[0] - target[0]) ** 2 + (best[1] - target[1]) ** 2
          ? point
          : best,
      )
      const out = [target[0] - junction[0], target[1] - junction[1]]
      side += Math.sign(track[0] * out[1] - track[1] * out[0])
    }
  })
  return side
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
/** The main route of each line, the lane of each line in its bundle, and the lines using each way. */
function overviewLanes(routes: readonly RouteSource[]) {
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

  // Lines that share a way form one bundle. Each line keeps its lane in the whole bundle, so it does not
  // step across its neighbours where the set of lines on a track changes. A line that leaves the bundle
  // keeps its lane, and the stations stay on the centre of the bundle.
  const parent = mains.map((_, index) => index)
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  for (const list of users.values()) for (const other of list) parent[find(other)] = find(list[0])
  const bundles = new Map<number, number[]>()
  mains.forEach((_, index) => bundles.set(find(index), [...(bundles.get(find(index)) ?? []), index]))
  // Within a bundle, a line that leaves on the left of the travel direction takes the left lane, so the
  // lines do not cross where they split. Ties keep the order of the groups.
  const sides = mains.map(({ route }) =>
    exitSide(route, (at) => (users.get(route.ways?.[at] ?? -1)?.length ?? 0) > 1, reference),
  )
  const laneOffset: number[] = mains.map(() => 0)
  for (const members of bundles.values()) {
    const ordered = [...members].sort((a, b) => sides[b] - sides[a] || a - b)
    ordered.forEach((index, lane) => {
      laneOffset[index] = (lane - (ordered.length - 1) / 2) * PARALLEL_SPACING
    })
  }

  return { mains, users, reference, laneOffset }
}

/** The lane offset of every route, by route id: the routes of a line share the offset of the line. */
export function laneOffsets(routes: readonly RouteSource[]): Map<number, number> {
  const { mains, laneOffset } = overviewLanes(routes)
  const offsets = new Map<number, number>()
  mains.forEach(({ group }, index) => {
    for (const route of group) offsets.set(route.id, laneOffset[index])
  })
  return offsets
}

/**
 * Moves a route's lines sideways by `offset` pixels, to the right of travel, computed here rather than by
 * the map. Each vertex gets one shared miter from the segments that meet there, so ways of one route join
 * without a gap, and the lines stay on the same lane as the stations drawn from lanes.
 */
function offsetLines(lines: [number, number][][], signs: readonly number[], offset: number, zoom: number): [number, number][][] {
  if (offset === 0) return lines
  const all = lines.flat()
  const meanLat = all.reduce((sum, [, lat]) => sum + lat, 0) / all.length
  const cos = Math.cos((meanLat * Math.PI) / 180)
  const project = ([lon, lat]: [number, number]): [number, number] => [lon * cos, -lat]
  const unproject = ([x, y]: [number, number]): [number, number] => [x / cos, -y]
  const unitsPerPixel = (360 / (512 * 2 ** zoom)) * cos
  const key = ([lon, lat]: [number, number]) => `${lon.toFixed(7)},${lat.toFixed(7)}`
  const incoming = new Map<string, [number, number][]>()
  const outgoing = new Map<string, [number, number][]>()
  const push = (map: Map<string, [number, number][]>, at: string, normal: [number, number]) => {
    map.set(at, [...(map.get(at) ?? []), normal])
  }
  lines.forEach((line, index) => {
    const sign = signs[index]
    for (let at = 0; at + 1 < line.length; at++) {
      const [ax, ay] = project(line[at])
      const [bx, by] = project(line[at + 1])
      const length = Math.hypot(bx - ax, by - ay) || 1
      // The right-hand normal of the segment, taken relative to the reference direction of the way.
      const normal: [number, number] = [(sign * -(by - ay)) / length, (sign * (bx - ax)) / length]
      push(outgoing, key(line[at]), normal)
      push(incoming, key(line[at + 1]), normal)
    }
  })
  const miter = (point: [number, number]): [number, number] => {
    const at = key(point)
    const before = incoming.get(at)?.[0] ?? outgoing.get(at)?.[0]
    const after = outgoing.get(at)?.[0] ?? before
    if (!before || !after) return [0, 0]
    const dot = before[0] * after[0] + before[1] * after[1]
    const denominator = Math.max(1 + dot, 0.25)
    let [mx, my] = [(before[0] + after[0]) / denominator, (before[1] + after[1]) / denominator]
    // A sharp turn would throw the miter far out; cap it at four pixels.
    const reach = Math.hypot(mx, my)
    if (reach > 4) [mx, my] = [(mx * 4) / reach, (my * 4) / reach]
    return [mx, my]
  }
  return lines.map((line) =>
    line.map((point) => {
      const [x, y] = project(point)
      const [mx, my] = miter(point)
      return unproject([x + mx * offset * unitsPerPixel, y + my * offset * unitsPerPixel])
    }),
  )
}

function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7
}

/** How many routes each way belongs to. */
function sharedWayCounts(routes: readonly RouteSource[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const route of routes) {
    for (const way of new Set(route.ways ?? [])) counts.set(way, (counts.get(way) ?? 0) + 1)
  }
  return counts
}

/**
 * The lines of one route as the overview draws them: oriented, then moved sideways by the route's lane offset.
 * Shared ways keep the direction the lanes were worked out for; any other way continues from the one before it.
 */
function drawnLines(
  route: RouteSource,
  reference: ReadonlyMap<number, [number, number][]>,
  sharedWays: ReadonlyMap<number, number>,
  offset: number,
  zoom: number,
): [number, number][][] {
  const oriented: [number, number][][] = []
  const signs: number[] = []
  let end: [number, number] | undefined
  route.lines.forEach((line, at) => {
    if (line.length < 2) return
    const way = route.ways?.[at]
    const ref = way !== undefined ? reference.get(way) : undefined
    // The way in its reference direction, which is the direction the offset is measured from.
    let drawn = ref && isReversed(line, ref) ? [...line].reverse() : line
    let sign = 1
    const shared = way !== undefined && (sharedWays.get(way) ?? 0) > 1
    if (!shared && end && samePoint(line[line.length - 1], end) && !samePoint(line[0], end)) {
      // Turned to continue the way before it. It is drawn in the direction of that way, so it keeps the side
      // of the corridor the way before it is on.
      drawn = [...line].reverse()
    }
    oriented.push(drawn)
    signs.push(sign)
    end = drawn[drawn.length - 1]
  })
  return offsetLines(oriented, signs, offset, zoom)
}

/** The point on the drawn lines nearest to a station, in the same screen frame as laneAnchor. */
function nearestDrawnPoint(lines: [number, number][][], point: [number, number]): [number, number] {
  const [lon, lat] = point
  const cos = Math.cos((lat * Math.PI) / 180)
  const project = ([x, y]: [number, number]): [number, number] => [x * cos, -y]
  const [px, py] = project([lon, lat])
  let best = { distance: Infinity, x: px, y: py }
  for (const line of lines) {
    for (let at = 0; at + 1 < line.length; at++) {
      const [ax, ay] = project(line[at])
      const [bx, by] = project(line[at + 1])
      const dx = bx - ax
      const dy = by - ay
      const length2 = dx * dx + dy * dy
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
      const x = ax + t * dx
      const y = ay + t * dy
      const distance = (px - x) ** 2 + (py - y) ** 2
      if (distance < best.distance) best = { distance, x, y }
    }
  }
  return [best.x / cos, -best.y]
}

export function linesToGeoJSON(routes: readonly RouteSource[], zoom = 12): OverviewCollection {
  const { mains, reference, laneOffset } = overviewLanes(routes)
  const sharedWays = sharedWayCounts(routes)

  const features: OverviewFeature[] = []
  mains.forEach(({ route, group }, index) => {
    const first = group[0]
    const { colour, valid } = resolveColour(first.tags.colour)
    const shifted = drawnLines(route, reference, sharedWays, laneOffset[index], zoom)
    for (const coordinates of shifted) {
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
          offset: laneOffset[index],
        },
      })
    }
  })
  return { type: 'FeatureCollection', features }
}

export interface SharedStationProperties {
  /** The colours of the first two lines that serve the station, in line order. */
  colourA: string
  colourB: string
  /** Screen angle, in degrees, of the line across the track: the long side of the station's shape. */
  angle: number
}

/**
 * Stations served by more than one line, for the zoomed-out view. The shape is drawn across the
 * tracks, so it is rotated to the track's direction at the station. Lines are taken from the main
 * route of each line, as in linesToGeoJSON.
 */
export function sharedStationsToGeoJSON(routes: readonly RouteSource[], zoom = 12): {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: SharedStationProperties }[]
} {
  const offsets = laneOffsets(routes)
  const { reference } = overviewLanes(routes)
  const sharedWays = sharedWayCounts(routes)
  const mains: { colour: string; route: RouteSource; drawn: [number, number][][] }[] = []
  for (const group of groupLines(routes)) {
    const route = mainRoute(group)
    if (route && route.lines.length > 0) {
      const offset = offsets.get(route.id) ?? 0
      mains.push({ colour: resolveColour(group[0].tags.colour).colour, route, drawn: drawnLines(route, reference, sharedWays, offset, zoom) })
    }
  }

  // Each station, by name or stop key, with the lines that serve it and the drawn lines of each.
  const stations = new Map<string, { lat: number; lon: number; lines: Map<number, { colour: string; drawn: [number, number][][] }> }>()
  mains.forEach(({ colour, drawn }, line) => {
    for (const stop of mains[line].route.stops ?? []) {
      const identity = stop.name ? stationName(stop.name) : stop.key
      const station = stations.get(identity) ?? { lat: stop.lat, lon: stop.lon, lines: new Map() }
      if (!station.lines.has(line)) station.lines.set(line, { colour, drawn })
      stations.set(identity, station)
    }
  })

  const features = []
  for (const station of stations.values()) {
    if (station.lines.size < 2) continue
    const [first, second] = [...station.lines.values()]
    // Each end of the shape sits on the drawn line of its colour, so the axis runs from one line to the other.
    const a = nearestDrawnPoint(first.drawn, [station.lon, station.lat])
    const b = nearestDrawnPoint(second.drawn, [station.lon, station.lat])
    const midLon = (a[0] + b[0]) / 2
    const midLat = (a[1] + b[1]) / 2
    const cos = Math.cos((midLat * Math.PI) / 180)
    const dx = (b[0] - a[0]) * cos
    const dy = -(b[1] - a[1])
    const separation = Math.hypot(dx, dy)
    const unitsPerPixel = (360 / (512 * 2 ** zoom)) * cos
    // The two lines coincide where they share one lane: the axis is then across the track, from the track itself.
    const angle =
      separation < unitsPerPixel / 2
        ? trackAngle(mains.map((main) => main.route), station.lon, station.lat, reference)
        : (Math.atan2(dy, dx) * 180) / Math.PI
    features.push({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [midLon, midLat] as [number, number] },
      properties: { colourA: first.colour, colourB: second.colour, angle },
    })
  }
  return { type: 'FeatureCollection', features }
}

/**
 * The screen angle, in degrees, of the line across the track at a point: the direction of the nearest
 * vertex of the routes, turned a quarter turn. Zero when no direction is known.
 */
function trackAngle(
  routes: readonly RouteSource[],
  lon: number,
  lat: number,
  reference: ReadonlyMap<number, [number, number][]>,
): number {
  let best: { distance: number; dx: number; dy: number } | undefined
  for (const route of routes) {
    route.lines.forEach((line, index) => {
      const way = route.ways?.[index]
      const ref = way !== undefined ? reference.get(way) : undefined
      // Direction as the segment is drawn: reversed where the overview draws it against its way.
      const flip = ref !== undefined && isReversed(line, ref) ? -1 : 1
      line.forEach(([x, y], at) => {
        const distance = (x - lon) ** 2 + (y - lat) ** 2
        if (best && distance >= best.distance) return
        const prev = line[Math.max(0, at - 1)]
        const next = line[Math.min(line.length - 1, at + 1)]
        best = { distance, dx: flip * (next[0] - prev[0]), dy: flip * (next[1] - prev[1]) }
      })
    })
  }
  if (!best || (best.dx === 0 && best.dy === 0)) return 0
  // Screen y points down, and east is scaled by the cosine of the latitude.
  const tx = best.dx * Math.cos((lat * Math.PI) / 180)
  const ty = -best.dy
  return (Math.atan2(tx, -ty) * 180) / Math.PI
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
