import type { BoundingBox, OverpassResponse } from './overpass'

// Boxes are snapped to a 0.1 degree grid, so small pans reuse the same request.
const GRID_PER_DEGREE = 10
const MAX_ENTRIES = 8

/** A box in tenths of a degree. Integers, so grid boxes compare exactly. */
export interface GridBox {
  south: number
  west: number
  north: number
  east: number
}

/** Snaps a box outward to the grid, so the snapped box always contains the original. */
export function snapToGrid(box: BoundingBox): GridBox {
  return {
    south: Math.floor(box.south * GRID_PER_DEGREE),
    west: Math.floor(box.west * GRID_PER_DEGREE),
    north: Math.ceil(box.north * GRID_PER_DEGREE),
    east: Math.ceil(box.east * GRID_PER_DEGREE),
  }
}

export function gridToBox(grid: GridBox): BoundingBox {
  return {
    south: grid.south / GRID_PER_DEGREE,
    west: grid.west / GRID_PER_DEGREE,
    north: grid.north / GRID_PER_DEGREE,
    east: grid.east / GRID_PER_DEGREE,
  }
}

function contains(outer: GridBox, inner: GridBox): boolean {
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  )
}

/**
 * Keeps the last few query results in memory. A response for a larger box also
 * holds every route that crosses a smaller box inside it, so a smaller view is
 * answered from it without a new request.
 */
export class RouteCache {
  private entries: { box: GridBox; response: OverpassResponse }[] = []

  find(box: GridBox): OverpassResponse | undefined {
    return this.entries.find((entry) => contains(entry.box, box))?.response
  }

  store(box: GridBox, response: OverpassResponse): void {
    this.entries.push({ box, response })
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
  }
}
