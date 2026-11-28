import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// Defaults for the data endpoints. Override them in .env (see .env.example).
const endpointDefaults = {
  VITE_OSM_API_URL: 'https://api.openstreetmap.org',
  VITE_NOMINATIM_URL: 'https://nominatim.openstreetmap.org',
}
type EndpointKey = keyof typeof endpointDefaults

// Overpass mirrors, in order of preference. Used only when the OSM API cannot answer.
const overpassDefault = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].join(',')

// OpenFreeMap only draws the basemap (see src/ui/map/base-style.ts).
const basemapOrigin = 'https://tiles.openfreemap.org'

// Builds the Content Security Policy, with connect-src limited to the
// configured endpoints. Applied to production builds only, because the Vite
// dev server injects inline scripts.
function contentSecurityPolicy(endpoints: Record<EndpointKey, string>, overpassUrls: string[]): Plugin {
  const connectSrc = new Set([
    "'self'",
    basemapOrigin,
    ...Object.values(endpoints).map((url) => new URL(url).origin),
    ...overpassUrls.map((url) => new URL(url).origin),
  ])
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${[...connectSrc].join(' ')}`,
  ].join('; ')
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const endpoints = Object.fromEntries(
    (Object.keys(endpointDefaults) as EndpointKey[]).map((key) => [
      key,
      env[key] || endpointDefaults[key],
    ]),
  ) as Record<EndpointKey, string>
  const overpassList = (env.VITE_OVERPASS_URLS || overpassDefault).split(',').map((url) => url.trim()).filter(Boolean)

  return {
    // The deploy workflow sets VITE_BASE=/<repository>/ for GitHub Pages.
    base: env.VITE_BASE || '/',
    plugins: [react(), tailwindcss(), contentSecurityPolicy(endpoints, overpassList)],
    define: {
      ...Object.fromEntries(
        Object.entries(endpoints).map(([key, value]) => [
          `import.meta.env.${key}`,
          JSON.stringify(value),
        ]),
      ),
      'import.meta.env.VITE_OVERPASS_URLS': JSON.stringify(overpassList.join(',')),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/core/**'],
        // config.ts only holds constants. idb-store.ts needs a browser database and is checked by hand.
        exclude: ['src/core/config.ts', 'src/core/data/idb-store.ts'],
        thresholds: { lines: 85, branches: 85 },
      },
    },
  }
})
