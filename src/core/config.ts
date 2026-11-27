// Constants and endpoints. Endpoint defaults are applied in vite.config.ts
// so the Content Security Policy and the app always agree on the origins.
export const config = {
  osmApiUrl: import.meta.env.VITE_OSM_API_URL,
  /** Overpass endpoints in order of preference; the client falls back when one is busy. */
  overpassUrls: import.meta.env.VITE_OVERPASS_URLS.split(",").map((url) => url.trim()).filter(Boolean),
  nominatimUrl: import.meta.env.VITE_NOMINATIM_URL,
  /** Minimum zoom to query lines from Overpass. To be tuned against real use. */
  minLineZoom: 12,
  /** Initial view: world map, without asking for geolocation. */
  initialView: { lat: 0, lon: 0, zoom: 1.5 },
} as const
