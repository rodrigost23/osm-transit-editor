// Place search with Nominatim. Only runs when the user submits the search, never while typing.

export interface Place {
  lat: number
  lon: number
  name: string
}

interface NominatimResult {
  lat: string
  lon: string
  display_name: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The first place matching the text, or null when there is none. */
export async function searchPlace(
  query: string,
  apiUrl: string,
  fetchFn: Fetch = (url, init) => fetch(url, init),
): Promise<Place | null> {
  // A plain GET with no custom headers, so the browser needs no CORS preflight.
  const response = await fetchFn(`${apiUrl}/search?format=json&limit=1&q=${encodeURIComponent(query)}`)
  if (!response.ok) throw new Error(`Place search failed: HTTP ${response.status}`)
  const [first] = (await response.json()) as NominatimResult[]
  if (!first) return null
  const lat = Number(first.lat)
  const lon = Number(first.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon, name: first.display_name }
}
