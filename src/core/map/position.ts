// Map position in the URL hash, in the same form iD uses: #map=zoom/lat/lon.

export interface MapPosition {
  lat: number
  lon: number
  zoom: number
}

const pattern = /^#?map=(\d{1,2}(?:\.\d+)?)\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)$/

/** Reads a position from a hash; returns null if it is missing or out of range. */
export function parseHash(hash: string): MapPosition | null {
  const match = pattern.exec(hash)
  if (!match) return null
  const zoom = Number(match[1])
  const lat = Number(match[2])
  const lon = Number(match[3])
  if (zoom > 24 || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null
  return { lat, lon, zoom }
}

/** Writes a position in the hash form, rounded like iD does. */
export function formatHash({ lat, lon, zoom }: MapPosition): string {
  return `#map=${zoom.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`
}
