// Web Mercator tiles. The OSM map call is made per tile, so the visible area is split into tiles.

export interface BoundingBox {
  south: number
  west: number
  north: number
  east: number
}

export interface Tile {
  x: number
  y: number
  z: number
}

export const TILE_ZOOM = 14

// Latitude limit of Web Mercator.
const MAX_LATITUDE = 85.0511

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Vertical tile position of a latitude, from 0 at the north pole to 1 at the south pole. */
function mercatorY(lat: number): number {
  const rad = (clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
}

/** Tiles that cover a box. Tiles that only touch its edge are included. */
export function tilesCovering(box: BoundingBox, zoom = TILE_ZOOM): Tile[] {
  const size = 2 ** zoom
  const xMin = clamp(Math.floor(((box.west + 180) / 360) * size), 0, size - 1)
  const xMax = clamp(Math.floor(((box.east + 180) / 360) * size), 0, size - 1)
  const yMin = clamp(Math.floor(mercatorY(box.north) * size), 0, size - 1)
  const yMax = clamp(Math.floor(mercatorY(box.south) * size), 0, size - 1)
  const tiles: Tile[] = []
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) tiles.push({ x, y, z: zoom })
  }
  return tiles
}

/** Geographic bounds of a tile. */
export function tileBox({ x, y, z }: Tile): BoundingBox {
  const size = 2 ** z
  const lon = (t: number) => (t / size) * 360 - 180
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / size))) * 180) / Math.PI
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) }
}

/** Four quarters of a box, used when the server refuses a box as too large. */
export function splitBox(box: BoundingBox): BoundingBox[] {
  const midLon = (box.west + box.east) / 2
  const midLat = (box.south + box.north) / 2
  return [
    { south: box.south, west: box.west, north: midLat, east: midLon },
    { south: box.south, west: midLon, north: midLat, east: box.east },
    { south: midLat, west: box.west, north: box.north, east: midLon },
    { south: midLat, west: midLon, north: box.north, east: box.east },
  ]
}
