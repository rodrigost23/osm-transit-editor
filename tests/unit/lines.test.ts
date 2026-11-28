import { describe, expect, it } from 'vitest'
import { lineColour, lineName, lineVariants, routeCentre, searchLines } from '@/core/data/lines'
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

describe('search and centre', () => {
  const routes = [
    { id: 2, tags: { name: 'Linha 2', ref: '2', operator: 'Metrô Rio' }, lines: [] },
    { id: 1, tags: { name: 'Linha 1', ref: '1', operator: 'Metrô Rio' }, lines: [[[-43.2, -22.9], [-43.0, -22.8]]] },
    { id: 3, tags: { name: 'Linha 1 Variante', ref: '1', operator: 'Metrô Rio' }, lines: [] },
  ] as RouteSource[]

  it('finds a line by name, ref or operator, ignoring case and accents, one result per line', () => {
    expect(searchLines(routes, 'LINHA 1').map((route) => route.id)).toEqual([1])
    expect(searchLines(routes, 'metro').map((route) => route.id)).toEqual([1, 2])
    expect(searchLines(routes, '  ')).toEqual([])
  })

  it('finds the middle of a route, and none for a route without points', () => {
    expect(routeCentre(routes[1])).toEqual({ lat: -22.85, lon: -43.1 })
    expect(routeCentre(routes[0])).toBeNull()
  })
})
