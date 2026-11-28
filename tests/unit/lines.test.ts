import { describe, expect, it } from 'vitest'
import { groupLines, lineColour, lineHeader, lineName, lineVariants, routeCentre, routesInView } from '@/core/data/lines'
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

describe('grouping by route master', () => {
  const master = (id: number, tags: Record<string, string>) => ({ id, tags })
  const withMaster = (id: number, tags: Record<string, string>, routeMaster: ReturnType<typeof master> | null): RouteSource => ({
    ...route(id, tags),
    master: routeMaster,
  })

  it('groups the routes of one route master together, both directions included', () => {
    const m = master(100, { type: 'route_master', name: 'Linha 1', ref: '1', colour: '#0000ff' })
    const routes = [
      withMaster(2, { type: 'route', ref: '1', name: 'Linha 1: A → B' }, m),
      withMaster(1, { type: 'route', ref: '1', name: 'Linha 1: B → A' }, m),
    ]
    const groups = groupLines(routes)
    expect(groups).toHaveLength(1)
    expect(groups[0].map((r) => r.id)).toEqual([1, 2])
    expect(lineVariants(routes, 2).map((r) => r.id)).toEqual([1, 2])
  })

  it('keeps routes without a master in one group per ref, network and operator', () => {
    const routes = [
      withMaster(1, { ref: '5', network: 'Metro', operator: 'X' }, null),
      withMaster(2, { ref: '5', network: 'Metro', operator: 'X' }, null),
      withMaster(3, { ref: '6', network: 'Metro', operator: 'X' }, null),
    ]
    expect(groupLines(routes).map((group) => group.map((r) => r.id))).toEqual([[1, 2], [3]])
  })

  it('keeps routes that have no master checked yet on the old grouping', () => {
    const routes = [route(1, { ref: '7' }), route(2, { ref: '7' })]
    expect(groupLines(routes).map((group) => group.map((r) => r.id))).toEqual([[1, 2]])
  })

  it('mixes master groups and orphans without merging them', () => {
    const m = master(200, { type: 'route_master', name: 'Linha 4', ref: '4' })
    const routes = [
      withMaster(10, { ref: '4', network: 'Metro' }, m),
      withMaster(11, { ref: '4', network: 'Metro' }, null),
      withMaster(12, { ref: '4', network: 'Metro' }, m),
    ]
    const groups = groupLines(routes).map((group) => group.map((r) => r.id))
    expect(groups).toEqual([[10, 12], [11]])
    expect(lineVariants(routes, 11).map((r) => r.id)).toEqual([11])
  })

  it('shows the master name, ref and colour, falling back to the route tags it lacks', () => {
    const m = master(300, { type: 'route_master', name: 'Linha 2', colour: '#ff0000' })
    const header = lineHeader(withMaster(20, { ref: '2', operator: 'Op' }, m))
    expect(header.tags).toMatchObject({ name: 'Linha 2', ref: '2', colour: '#ff0000', operator: 'Op' })
    expect(lineHeader(withMaster(21, { ref: '2' }, null)).tags).toEqual({ ref: '2' })
  })
})
