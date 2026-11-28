import { describe, expect, it } from 'vitest'
import { parseOsmJson } from '@/core/data/osm-json'

const SAMPLE = JSON.stringify({
  version: '0.6',
  elements: [
    { type: 'node', id: 1, lat: -22.9, lon: -43.19 },
    { type: 'node', id: 2, lat: -22.91, lon: -43.18, tags: { railway: 'station' } },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'service' } },
    {
      type: 'relation',
      id: 7,
      members: [
        { type: 'way', ref: 10, role: '' },
        { type: 'node', ref: 2, role: 'stop' },
      ],
      tags: { route: 'subway', name: 'Metrô Linha 1' },
    },
    { id: 99 },
  ],
})

describe('parseOsmJson', () => {
  const data = parseOsmJson(SAMPLE)

  it('reads nodes, ways and relations by id', () => {
    expect(data.nodes.get(1)).toEqual({ lat: -22.9, lon: -43.19, tags: {} })
    expect(data.ways.get(10)).toEqual({ nodes: [1, 2], tags: { highway: 'service' } })
    expect(data.relations.get(7)).toEqual({
      tags: { route: 'subway', name: 'Metrô Linha 1' },
      members: [
        { type: 'way', ref: 10, role: '' },
        { type: 'node', ref: 2, role: 'stop' },
      ],
    })
  })

  it('leaves out elements without an id and nodes without tags', () => {
    expect(data.relations.size).toBe(1)
    expect(data.ways.size).toBe(1)
    expect(data.nodes.get(2)).toEqual({ lat: -22.91, lon: -43.18, tags: { railway: 'station' } })
  })

  it('rejects a response without an elements list', () => {
    expect(() => parseOsmJson('{"version":"0.6"}')).toThrow('no elements list')
  })

  it('defaults missing tags, nodes and member roles', () => {
    const data = parseOsmJson(
      JSON.stringify({
        elements: [
          { type: 'way', id: 1 },
          { type: 'relation', id: 2, members: [{ type: 'way', ref: 1 }] },
          { type: 'relation', id: 3 },
        ],
      }),
    )
    expect(data.ways.get(1)).toEqual({ nodes: [], tags: {} })
    expect(data.relations.get(2)).toEqual({ tags: {}, members: [{ type: 'way', ref: 1, role: '' }] })
    expect(data.relations.get(3)).toEqual({ tags: {}, members: [] })
  })
})
