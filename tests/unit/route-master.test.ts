import { describe, expect, it } from 'vitest'
import { routeMasterOf } from '@/core/data/route-loader'
import { parseOsmJson } from '@/core/data/osm-json'

const parents = (elements: unknown[]) => parseOsmJson(JSON.stringify({ elements }))

describe('routeMasterOf', () => {
  it('returns the route_master among the parent relations, with its tags', () => {
    const data = parents([
      { type: 'relation', id: 7, tags: { type: 'multipolygon' }, members: [] },
      { type: 'relation', id: 50, tags: { type: 'route_master', ref: '1', name: 'Linha 1' }, members: [] },
    ])
    expect(routeMasterOf(data)).toEqual({ id: 50, tags: { type: 'route_master', ref: '1', name: 'Linha 1' } })
  })

  it('returns null for an orphan route with no route_master parent', () => {
    expect(routeMasterOf(parents([{ type: 'relation', id: 7, tags: { type: 'site' }, members: [] }]))).toBeNull()
    expect(routeMasterOf(parents([]))).toBeNull()
  })
})
