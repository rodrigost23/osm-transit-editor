import type { RouteSource, Stop } from '@/core/data/geojson'
import { lineName } from '@/core/data/lines'

/** The line's name without a trailing "(from → to)" part, which the direction labels show instead. */
export function displayLineName(route: RouteSource): string {
  return lineName(route).replace(/\s*\([^)]*\)\s*$/, '')
}

/** A station name without the " - Sentido ..." suffix that some OSM stop names carry. */
export function displayStopName(name: string): string {
  return name.replace(/\s+-\s+Sentido\b.*$/i, '')
}

/**
 * A direction label from the route's first and last station, so both directions
 * read differently. Falls back to the route's to tag when it has no stations.
 */
export function directionLabel(route: RouteSource): string {
  const named = (route.stops ?? []).filter((stop: Stop) => stop.name)
  if (named.length >= 2) {
    return `${displayStopName(named[0].name)} → ${displayStopName(named[named.length - 1].name)}`
  }
  return route.tags.to ? `→ ${route.tags.to}` : lineName(route)
}
