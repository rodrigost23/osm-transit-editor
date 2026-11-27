const env = import.meta.env ?? {}

export const config = {
  osmApiUrl: env.VITE_OSM_API_URL ?? 'https://api.openstreetmap.org',
  overpassUrl: env.VITE_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  nominatimUrl: env.VITE_NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  basemapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  /** Minimum zoom to query lines from Overpass. To be tuned while testing milestone 0. */
  minLineZoom: 12,
  /** Initial view: world map, without asking for geolocation. */
  initialView: { lat: 0, lon: 0, zoom: 1.5 },
} as const
