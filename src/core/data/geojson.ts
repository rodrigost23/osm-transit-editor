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
