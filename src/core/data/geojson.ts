import { resolveColour } from './colour'

/** A subway route, with its full line geometry as [lon, lat] pairs. */
export interface RouteSource {
  id: number
  tags: Record<string, string>
  lines: [number, number][][]
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
