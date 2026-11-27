import { resolveColour } from './colour'
import type { OverpassResponse, OverpassRelation } from './overpass'

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

/** Converts subway route relations into one MultiLineString per route. */
export function routesToGeoJSON(response: OverpassResponse): RouteCollection {
  return {
    type: 'FeatureCollection',
    features: response.elements.flatMap((relation) => toFeature(relation)),
  }
}

function toFeature(relation: OverpassRelation): RouteFeature[] {
  const lines = (relation.members ?? [])
    .filter((member) => member.type === 'way' && member.geometry && member.geometry.length > 1)
    .map((member) => member.geometry!.map((point): [number, number] => [point.lon, point.lat]))
  if (lines.length === 0) return []
  const tags = relation.tags ?? {}
  const { colour, valid } = resolveColour(tags.colour)
  return [
    {
      type: 'Feature',
      id: relation.id,
      geometry: { type: 'MultiLineString', coordinates: lines },
      properties: {
        relationId: relation.id,
        ref: tags.ref ?? '',
        name: tags.name ?? '',
        operator: tags.operator ?? '',
        colour,
        colourValid: valid,
      },
    },
  ]
}
