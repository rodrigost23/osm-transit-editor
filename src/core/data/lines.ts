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

/**
 * The routes that belong to the same line as the given one: same ref, network and
 * operator. A line usually has one route per direction, so this gives both.
 */
export function lineVariants(routes: readonly RouteSource[], id: number): RouteSource[] {
  const line = routes.find((route) => route.id === id)
  if (!line) return []
  const key = lineKey(line)
  return routes.filter((route) => lineKey(route) === key).sort((a, b) => a.id - b.id)
}

function lineKey(route: RouteSource): string {
  return [route.tags.ref, route.tags.network, route.tags.operator].map((value) => value ?? '').join('|')
}
