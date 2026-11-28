import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'
import { routesToGeoJSON, type RouteCollection } from '@/core/data/geojson'
import { RouteLoader } from '@/core/data/route-loader'
import { formatHash, parseHash } from '@/core/map/position'
import { baseStyleUrl } from './base-style'

// MapLibre 6 resolves its worker next to its own module, which a bundler does
// not emit. Pointing it at the bundled asset keeps the worker under the base path.
maplibregl.setWorkerUrl(workerUrl)

const SOURCE_ID = 'transit-routes'
const LAYER_ID = 'transit-routes-line'
// Wait for the map to settle before querying, so a fast pan or zoom sends one request.
const MOVE_DEBOUNCE_MS = 400
const emptyRoutes: RouteCollection = { type: 'FeatureCollection', features: [] }

export function MapView() {
  const container = useRef<HTMLDivElement>(null)
  const retry = useRef<() => void>(() => {})
  const [zoomedOut, setZoomedOut] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!container.current) return
    const start = parseHash(window.location.hash) ?? config.initialView
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyleUrl,
      center: [start.lon, start.lat],
      zoom: start.zoom,
    })

    // Each new view cancels the request still in flight, so only the latest view can update the map.
    let controller: AbortController | undefined
    const loader = new RouteLoader(config.osmApiUrl)
    let debounce: ReturnType<typeof setTimeout> | undefined
    const loadLines = async () => {
      const source = map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)
      if (!source) return
      controller?.abort()
      if (map.getZoom() < config.minLineZoom) {
        source.setData(emptyRoutes)
        setZoomedOut(true)
        setLoading(false)
        setLoadError(false)
        return
      }
      setZoomedOut(false)
      const current = new AbortController()
      controller = current
      const bounds = map.getBounds()
      setLoading(true)
      try {
        const routes = await loader.load(
          { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() },
          current.signal,
        )
        // Null means the view covers too many tiles to load at once.
        source.setData(routes ? routesToGeoJSON(routes) : emptyRoutes)
        setZoomedOut(routes === null)
        setLoading(false)
        setLoadError(false)
      } catch (error) {
        if (current.signal.aborted) return
        console.error('Could not load subway routes:', error)
        setLoading(false)
        setLoadError(true)
      }
    }
    retry.current = () => void loadLines()

    // Keep the position in the hash so a reload or a shared link opens the same place.
    // replaceState does not fire hashchange, so this does not loop.
    const writeHash = () => {
      const center = map.getCenter()
      const hash = formatHash({ lat: center.lat, lon: center.lng, zoom: map.getZoom() })
      window.history.replaceState(null, '', hash)
    }

    map.on('load', () => {
      map.addSource(SOURCE_ID, { type: 'geojson', data: emptyRoutes })
      map.addLayer({
        id: LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': 4 },
      })
      void loadLines()
    })
    map.on('moveend', () => {
      writeHash()
      clearTimeout(debounce)
      debounce = setTimeout(() => void loadLines(), MOVE_DEBOUNCE_MS)
    })
    map.on('error', (event) => console.error('MapLibre error:', event.error))
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    return () => {
      clearTimeout(debounce)
      controller?.abort()
      map.remove()
    }
  }, [])

  // Inline style: MapLibre's own stylesheet sets position: relative on the
  // container with the same specificity, which would collapse the map to 0px.
  return (
    <>
      <div ref={container} className="map" style={{ position: 'absolute', inset: 0 }} />
      {zoomedOut && <p className="zoom-hint">Zoom in to see lines.</p>}
      {loading && !zoomedOut && !loadError && <p className="zoom-hint">Loading lines…</p>}
      {loadError && (
        <div className="map-notice" role="alert">
          <span>Could not load lines. The OpenStreetMap API may be busy.</span>
          <button type="button" onClick={() => retry.current()}>
            Try again
          </button>
        </div>
      )}
    </>
  )
}
