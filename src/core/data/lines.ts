import { resolveColour } from './colour'
import type { RouteSource } from './geojson'

/** A line's display name: its name tag, then its ref. */
export function lineName(route: RouteSource): string {
  return route.tags.name || route.tags.ref || `Relation ${route.id}`
}

/** The colour to draw a line in, grey when the tag is missing or not a hex colour. */
export function lineColour(route: RouteSource): string {
  return resolveColour(route.tags.colour).colour
}

/** Tags a route master can give its line. Each one wins over the route's own tag when the master has it. */
const MASTER_TAGS = ['name', 'ref', 'colour', 'network', 'operator'] as const

/**
 * The route as its line is shown: when the route has a route_master, the master's name, ref,
 * colour, network and operator take the place of the route's own, and the route's other tags stay.
 */
export function lineHeader(route: RouteSource): RouteSource {
  const master = route.master
  if (!master) return route
  const tags = { ...route.tags }
  for (const key of MASTER_TAGS) {
    if (master.tags[key]) tags[key] = master.tags[key]
  }
  return { ...route, tags }
}

/**
 * The routes that belong to the same line as the given one. Routes with a route_master form
 * one line with their master. Orphan routes form one line per ref, network and operator.
 * A line usually has one route per direction, so this gives both.
 */
export function lineVariants(routes: readonly RouteSource[], id: number): RouteSource[] {
  const line = routes.find((route) => route.id === id)
  if (!line) return []
  const key = lineKey(line)
  return routes.filter((route) => lineKey(route) === key).sort((a, b) => a.id - b.id)
}

/** The key of the line a route belongs to: its route_master, or for an orphan route its ref, network and operator. */
export function lineKey(route: RouteSource): string {
  if (route.master) return `master:${route.master.id}`
  return [route.tags.ref, route.tags.network, route.tags.operator].map((value) => value ?? '').join('|')
}

/** The routes of each line, in id order: one line per route_master, or per ref, network and operator for orphans. */
export function groupLines(routes: readonly RouteSource[]): RouteSource[][] {
  const groups = new Map<string, RouteSource[]>()
  for (const route of [...routes].sort((a, b) => a.id - b.id)) {
    const key = lineKey(route)
    groups.set(key, [...(groups.get(key) ?? []), route])
  }
  return [...groups.values()]
}

/** The routes with at least one point inside the box. */
export function routesInView(routes: readonly RouteSource[], box: { south: number; west: number; north: number; east: number }): RouteSource[] {
  return routes.filter((route) =>
    route.lines.some((line) => line.some(([lon, lat]) => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east)),
  )
}

/** The middle of a route's points, or null when it has none. */
export function routeCentre(route: RouteSource): { lat: number; lon: number } | null {
  const points = route.lines.flat()
  if (points.length === 0) return null
  const lon = points.reduce((sum, [x]) => sum + x, 0) / points.length
  const lat = points.reduce((sum, [, y]) => sum + y, 0) / points.length
  return { lat, lon }
}
