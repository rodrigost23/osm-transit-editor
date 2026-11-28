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

/** Lower case, without accents, so that "metro" finds "Metrô". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** One route per line whose name, ref or operator contains the text. */
export function searchLines(routes: readonly RouteSource[], query: string, limit = 8): RouteSource[] {
  const needle = fold(query.trim())
  if (!needle) return []
  const found: RouteSource[] = []
  const keys = new Set<string>()
  for (const route of [...routes].sort((a, b) => a.id - b.id)) {
    const haystack = fold([lineName(route), route.tags.ref, route.tags.operator].join(' '))
    const key = lineKey(route)
    if (!haystack.includes(needle) || keys.has(key)) continue
    keys.add(key)
    found.push(route)
    if (found.length >= limit) break
  }
  return found
}

/** The middle of a route's points, or null when it has none. */
export function routeCentre(route: RouteSource): { lat: number; lon: number } | null {
  const points = route.lines.flat()
  if (points.length === 0) return null
  const lon = points.reduce((sum, [x]) => sum + x, 0) / points.length
  const lat = points.reduce((sum, [, y]) => sum + y, 0) / points.length
  return { lat, lon }
}
