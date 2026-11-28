// Reads the JSON of the OSM API (map.json and relation/{id}/full.json).

export interface OsmNode {
  lat: number
  lon: number
}

export interface OsmWay {
  nodes: number[]
  tags: Record<string, string>
}

export interface OsmMember {
  type: string
  ref: number
  role: string
}

export interface OsmRelation {
  tags: Record<string, string>
  members: OsmMember[]
}

export interface OsmData {
  nodes: Map<number, OsmNode>
  ways: Map<number, OsmWay>
  relations: Map<number, OsmRelation>
}

interface JsonElement {
  type?: string
  id?: number
  lat?: number
  lon?: number
  nodes?: number[]
  tags?: Record<string, string>
  members?: { type: string; ref: number; role?: string }[]
}

export function parseOsmJson(text: string): OsmData {
  const json = JSON.parse(text) as { elements?: JsonElement[] }
  if (!Array.isArray(json.elements)) throw new Error('Unexpected response: no elements list')
  const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map() }
  for (const element of json.elements) {
    if (element.id === undefined) continue
    if (element.type === 'node') {
      data.nodes.set(element.id, { lat: element.lat ?? NaN, lon: element.lon ?? NaN })
    } else if (element.type === 'way') {
      data.ways.set(element.id, { nodes: element.nodes ?? [], tags: element.tags ?? {} })
    } else if (element.type === 'relation') {
      data.relations.set(element.id, {
        tags: element.tags ?? {},
        members: (element.members ?? []).map((member) => ({
          type: member.type,
          ref: member.ref,
          role: member.role ?? '',
        })),
      })
    }
  }
  return data
}
