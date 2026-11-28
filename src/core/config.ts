// Constants and endpoints. Endpoint defaults are applied in vite.config.ts
// so the Content Security Policy and the app always agree on the origins.
export const config = {
  osmApiUrl: import.meta.env.VITE_OSM_API_URL,
  nominatimUrl: import.meta.env.VITE_NOMINATIM_URL,
  /** Minimum zoom to query lines. Matches the tile zoom used for the OSM map calls. */
  minLineZoom: 14,
  /** Initial view: world map, without asking for geolocation. */
  initialView: { lat: 0, lon: 0, zoom: 1.5 },
} as const
