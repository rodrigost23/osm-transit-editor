// Reads the XML of the OSM API (map and relation calls). The format is machine-written
// and regular, so a small reader is enough and avoids a DOM dependency.

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

// An opening, closing or self-closing element, for example <tag k="a" v="b"/>.
const ELEMENT = /<(\/?)([A-Za-z]+)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g
const ATTRIBUTE = /([\w:]+)="([^"]*)"/g
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return codePoint(parseInt(body.slice(2), 16), match)
    if (body.startsWith('#')) return codePoint(parseInt(body.slice(1), 10), match)
    return NAMED_ENTITIES[body] ?? match
  })
}

function codePoint(code: number, fallback: string): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : fallback
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [, key, value] of text.matchAll(ATTRIBUTE)) result[key] = decodeEntities(value)
  return result
}

export function parseOsmXml(xml: string): OsmData {
  const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map() }
  // The element whose children (tag, nd, member) are being read.
  let open: { type: 'node' | 'way' | 'relation'; id: number } | undefined

  for (const [, closing, name, attributeText, selfClosing] of xml.matchAll(ELEMENT)) {
    if (closing) {
      if (open && name === open.type) open = undefined
      continue
    }
    const attrs = attributes(attributeText)
    const id = Number(attrs.id)
    switch (name) {
      case 'node':
        data.nodes.set(id, { lat: Number(attrs.lat), lon: Number(attrs.lon) })
        if (!selfClosing) open = { type: 'node', id }
        break
      case 'way':
        data.ways.set(id, { nodes: [], tags: {} })
        if (!selfClosing) open = { type: 'way', id }
        break
      case 'relation':
        data.relations.set(id, { tags: {}, members: [] })
        if (!selfClosing) open = { type: 'relation', id }
        break
      case 'nd':
        if (open?.type === 'way') data.ways.get(open.id)?.nodes.push(Number(attrs.ref))
        break
      case 'tag': {
        const target =
          open?.type === 'way' ? data.ways.get(open.id) : open?.type === 'relation' ? data.relations.get(open.id) : undefined
        if (target) target.tags[attrs.k] = attrs.v
        break
      }
      case 'member':
        if (open?.type === 'relation') {
          data.relations.get(open.id)?.members.push({ type: attrs.type, ref: Number(attrs.ref), role: attrs.role ?? '' })
        }
        break
    }
  }
  return data
}
