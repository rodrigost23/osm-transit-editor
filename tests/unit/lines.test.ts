import { describe, expect, it } from 'vitest'
import { groupLines, lineColour, lineName, lineVariants, routeCentre, routesInView } from '@/core/data/lines'
import type { RouteSource } from '@/core/data/geojson'

const route = (id: number, tags: Record<string, string>): RouteSource => ({ id, tags, lines: [] })

describe('line helpers', () => {
  it('names a line by its name, then its ref, then its relation id', () => {
    expect(lineName(route(1, { name: 'Linha 1', ref: '1' }))).toBe('Linha 1')
    expect(lineName(route(2, { ref: '1' }))).toBe('1')
    expect(lineName(route(3, {}))).toBe('Relation 3')
  })

  it('falls back to grey for a missing colour', () => {
    expect(lineColour(route(1, { colour: '#f58220' }))).toBe('#f58220')
    expect(lineColour(route(2, {}))).toBe('#8a8a8a')
  })

  it('groups the routes of one line by ref, network and operator', () => {
    const routes = [
      route(5, { ref: '1', operator: 'Metrô Rio', network: 'Metrô' }),
      route(3, { ref: '1', operator: 'Metrô Rio', network: 'Metrô' }),
      route(4, { ref: '2', operator: 'Metrô Rio', network: 'Metrô' }),
    ]
    expect(lineVariants(routes, 5).map((variant) => variant.id)).toEqual([3, 5])
    expect(lineVariants(routes, 99)).toEqual([])
  })
})

describe('centre, grouping and view', () => {
  const routes = [
    { id: 2, tags: { name: 'Linha 2', ref: '2', operator: 'Metrô Rio' }, lines: [] },
    { id: 1, tags: { name: 'Linha 1', ref: '1', operator: 'Metrô Rio' }, lines: [[[-43.2, -22.9], [-43.0, -22.8]]] },
    { id: 3, tags: { name: 'Linha 1 Variante', ref: '1', operator: 'Metrô Rio' }, lines: [] },
  ] as RouteSource[]

  it('groups routes by line, in id order', () => {
    expect(groupLines(routes).map((group) => group.map((route) => route.id))).toEqual([[1, 3], [2]])
  })

  it('keeps routes with a point inside the box', () => {
    expect(routesInView(routes, { south: -23, north: -22.85, west: -43.3, east: -43.1 }).map((route) => route.id)).toEqual([1])
    expect(routesInView(routes, { south: 0, north: 1, west: 0, east: 1 })).toEqual([])
  })

  it('finds the middle of a route, and none for a route without points', () => {
    expect(routeCentre(routes[1])).toEqual({ lat: -22.85, lon: -43.1 })
    expect(routeCentre(routes[0])).toBeNull()
  })
})
