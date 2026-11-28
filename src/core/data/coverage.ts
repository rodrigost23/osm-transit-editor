// Which parts of the map were already asked for, and which subway routes were in them.
//
// The map is split into zoom-14 tiles. Tiles are grouped into cells of 64 x 64 tiles, so one
// stored record covers a large area and its size does not depend on the zoom of the view.
// A cell keeps "segments": the tiles that one request covered, with the route IDs it found.

import { tilesCovering, tileBox, type BoundingBox, type Tile } from './tiles'

/** A cell holds 2^6 tiles on each side. */
const CELL_SHIFT = 6
const CELL_MASK = (1 << CELL_SHIFT) - 1

/** Tiles of one request. `t` are tile offsets inside the cell, `i` the route IDs, `s` when it was saved. */
export interface Segment {
  t: number[]
  i: number[]
  s: number
}

export interface Cell {
  segs: Segment[]
}

/** The cell a tile belongs to, and the tile's offset inside that cell. */
export function cellOf(tile: Tile): { key: string; offset: number } {
  return {
    key: `${tile.x >> CELL_SHIFT}/${tile.y >> CELL_SHIFT}`,
    offset: ((tile.y & CELL_MASK) << CELL_SHIFT) | (tile.x & CELL_MASK),
  }
}

/** Each covered tile offset mapped to its segment. A tile is in at most one segment of a cell. */
export function segmentIndex(cell: Cell): Map<number, Segment> {
  const at = new Map<number, Segment>()
  for (const segment of cell.segs) for (const offset of segment.t) at.set(offset, segment)
  return at
}

/** Tiles whose area overlaps the box. Tiles that only touch its edge are left out. */
export function tilesIn(box: BoundingBox): Tile[] {
  return tilesCovering(box).filter((tile) => {
    const bounds = tileBox(tile)
    return bounds.east > box.west && bounds.west < box.east && bounds.north > box.south && bounds.south < box.north
  })
}

/** The box made of whole tiles that holds all the given tiles. */
export function areaOf(tiles: Tile[]): BoundingBox {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const tile of tiles) {
    minX = Math.min(minX, tile.x)
    maxX = Math.max(maxX, tile.x)
    minY = Math.min(minY, tile.y)
    maxY = Math.max(maxY, tile.y)
  }
  const z = tiles[0]?.z ?? 14
  const top = tileBox({ x: minX, y: minY, z })
  const bottom = tileBox({ x: maxX, y: maxY, z })
  return { west: top.west, north: top.north, east: bottom.east, south: bottom.south }
}

/** True when two boxes overlap or touch. */
export function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}
