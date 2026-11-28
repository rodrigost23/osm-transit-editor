/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSM_API_URL: string
  readonly VITE_NOMINATIM_URL: string
  /** Comma-separated Overpass mirrors, in order of preference. */
  readonly VITE_OVERPASS_URLS: string
  readonly VITE_OSM_CLIENT_ID_PROD?: string
  readonly VITE_OSM_CLIENT_ID_DEV?: string
  readonly VITE_OSM_REDIRECT_URI?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
