import { Button } from '@/ui/components/ui/button'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'
import {
  badgesToGeoJSON,
  linesToGeoJSON,
  RouteChangeTracker,
  stopsToGeoJSON,
  type PointCollection,
  type RouteCollection,
  type RouteSource,
} from '@/core/data/geojson'
import { IndexedDbStore } from '@/core/data/idb-store'
import { lineVariants, routesInView } from '@/core/data/lines'
import { describeError, RouteLoader } from '@/core/data/route-loader'
import { LayeredStore, MemoryStore } from '@/core/data/store'
import { formatHash, parseHash } from '@/core/map/position'
import { baseStyleUrl } from './base-style'
import { LineCard } from './LineCard'

// MapLibre 6 resolves its worker next to its own module, which a bundler does
// not emit. Pointing it at the bundled asset keeps the worker under the base path.
maplibregl.setWorkerUrl(workerUrl)

/** A place the map should move to. A new id moves the map, even to the same place. */
export interface MapTarget {
  lat: number
  lon: number
  zoom: number
  id: number
}

const SOURCE_ID = 'transit-routes'
const CASING_LAYER_ID = 'routes-casing'
const LAYER_ID = 'transit-routes-line'
// Zoomed out, one line per route name, drawn from the visible zoom up to the zoom where routes take over.
const OVERVIEW_SOURCE_ID = 'transit-overview'
const OVERVIEW_LAYER_ID = 'transit-overview-line'
const BADGE_SOURCE_ID = 'transit-badges'
const BADGE_LAYER_ID = 'transit-badges-circle'
const BADGE_TEXT_ID = 'transit-badges-ref'
const BADGE_MODE_ID = 'transit-badges-mode'
const STOP_SOURCE_ID = 'transit-stops'
const STOP_LAYER_ID = 'transit-stops-circle'
const STOP_LABEL_ID = 'transit-stops-name'
// Badges are too crowded to read below this zoom.
const BADGE_MIN_ZOOM = 12
// Stations are drawn, and named, from this zoom on.
const STOP_MIN_ZOOM = 14
// Wait for the map to settle before querying, so a fast pan or zoom sends one request.
const MOVE_DEBOUNCE_MS = 400
const emptyRoutes: RouteCollection = { type: 'FeatureCollection', features: [] }
const emptyPoints: PointCollection = { type: 'FeatureCollection', features: [] }

interface MapViewProps {
  target?: MapTarget
  /** Every route loaded so far. The parent keeps it, so it can search them. */
  known: RouteSource[]
  setKnown: Dispatch<SetStateAction<RouteSource[]>>
  /** The line the user picked, on the map or in the search. */
  selectedId: number | null
  setSelectedId: Dispatch<SetStateAction<number | null>>
  /** The routes with a point in the visible area, for the list of lines on screen. */
  setVisible: Dispatch<SetStateAction<RouteSource[]>>
}

export function MapView({ target, known, setKnown, selectedId, setSelectedId, setVisible }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const retry = useRef<() => void>(() => {})
  const reload = useRef<() => void>(() => {})
  // Seconds until the OSM API is asked again after a rate limit, or null when no cooldown is running.
  const [waitSeconds, setWaitSeconds] = useState<number | null>(null)
  const [zoomedOut, setZoomedOut] = useState(false)
  const [loading, setLoading] = useState(false)
  // What went wrong with the last load, or null when everything in view loaded.
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!container.current) return
    const start = parseHash(window.location.hash) ?? config.initialView
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyleUrl,
      center: [start.lon, start.lat],
      zoom: start.zoom,
    })
    mapRef.current = map

    // Each new view cancels the request still in flight, so only the latest view can update the map.
    let controller: AbortController | undefined
    const drawn = new RouteChangeTracker()
    const seen = new Map<number, RouteSource>()
    // The routes on screen, from the routes loaded so far.
    const publishVisible = () => {
      const bounds = map.getBounds()
      setVisible(
        routesInView([...seen.values()], { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() }),
      )
    }
    const loader = new RouteLoader(config.osmApiUrl, {
      store: new LayeredStore(new MemoryStore(300), new IndexedDbStore()),
      onCooldown: (until) => setWaitSeconds(Math.ceil((until - Date.now()) / 1000)),
    })
    let debounce: ReturnType<typeof setTimeout> | undefined
    const loadLines = async (refresh = false) => {
      const source = map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)
      if (!source) return
      const badges = map.getSource<maplibregl.GeoJSONSource>(BADGE_SOURCE_ID)
      const stops = map.getSource<maplibregl.GeoJSONSource>(STOP_SOURCE_ID)
      const overview = map.getSource<maplibregl.GeoJSONSource>(OVERVIEW_SOURCE_ID)
      // Lines, badges and stations come from the same routes, so they are set together.
      const show = (routes: RouteSource[], next: RouteCollection) => {
        source.setData(next)
        overview?.setData(linesToGeoJSON(routes))
        badges?.setData(badgesToGeoJSON(routes))
        stops?.setData(stopsToGeoJSON(routes))
        publishVisible()
      }
      controller?.abort()
      if (map.getZoom() < config.minLineZoom) {
        // Zoomed out, nothing is requested. Lines loaded so far stay on the map.
        const current = new AbortController()
        controller = current
        if (map.getZoom() >= config.lineVisibleZoom) {
          // Routes saved by earlier visits show from the visible zoom on, without a request.
          const bounds = map.getBounds()
          const saved = await loader
            .cached({ south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() }, current.signal)
            .catch(() => null)
          if (current.signal.aborted) return
          let added = false
          for (const route of saved ?? []) {
            if (seen.has(route.id)) continue
            seen.set(route.id, route)
            added = true
          }
          if (added) setKnown([...seen.values()])
        }
        const routes = [...seen.values()]
        const next = drawn.next(routes)
        if (next) show(routes, next)
        setZoomedOut(map.getZoom() < config.lineVisibleZoom)
        setLoading(false)
        setLoadError(null)
        return
      }
      setZoomedOut(false)
      const left = loader.cooldownLeft()
      setWaitSeconds(left > 0 ? Math.ceil(left / 1000) : null)
      const current = new AbortController()
      controller = current
      const bounds = map.getBounds()
      setLoading(true)
      try {
        // Routes are drawn as parts of the view arrive, and again when all of it has.
        // Only a change in the set of routes reaches the map, so the lines do not flicker on every response.
        const draw = (routes: RouteSource[]) => {
          for (const route of routes) seen.set(route.id, route)
          setKnown([...seen.values()])
          const next = drawn.next(routes)
          if (next) show(routes, next)
        }
        const result = await loader.load(
          { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() },
          current.signal,
          (partial) => draw(partial.routes),
          { refresh },
        )
        // Routes that did load stay drawn even when some requests failed.
        draw(result.routes)
        if (result.failures.length > 0) {
          console.error('Some subway route requests failed:', result.failures)
          const first = result.failures[0]
          setLoadError(
            `${result.failures.length} of the requests for this view failed (${first.reason}, ${first.kind} ${first.url}). Routes that loaded are shown.`,
          )
        } else {
          setLoadError(null)
        }
        setLoading(false)
        setWaitSeconds(null)
      } catch (error) {
        if (current.signal.aborted) return
        console.error('Could not load subway routes:', error)
        setLoading(false)
        setLoadError(`Could not load lines: ${describeError(error)}.`)
      }
    }
    retry.current = () => void loadLines()
    reload.current = () => void loadLines(true)

    // Keep the position in the hash so a reload or a shared link opens the same place.
    // replaceState does not fire hashchange, so this does not loop.
    const writeHash = () => {
      const center = map.getCenter()
      const hash = formatHash({ lat: center.lat, lon: center.lng, zoom: map.getZoom() })
      window.history.replaceState(null, '', hash)
    }

    map.on('load', () => {
      map.addSource(SOURCE_ID, { type: 'geojson', data: emptyRoutes })
      map.addSource(OVERVIEW_SOURCE_ID, { type: 'geojson', data: emptyRoutes })
      map.addLayer({
        id: OVERVIEW_LAYER_ID,
        type: 'line',
        source: OVERVIEW_SOURCE_ID,
        minzoom: config.lineVisibleZoom,
        maxzoom: config.minLineZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': 3 },
      })
      map.addSource(BADGE_SOURCE_ID, { type: 'geojson', data: emptyPoints })
      map.addSource(STOP_SOURCE_ID, { type: 'geojson', data: emptyPoints })
      // A white casing under each route keeps it readable over the basemap.
      map.addLayer({
        id: CASING_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        minzoom: config.minLineZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      })
      map.addLayer({
        id: LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        minzoom: config.minLineZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': 6 },
      })
      // Stations sit under the badges, and are named from STOP_MIN_ZOOM on.
      map.addLayer({
        id: STOP_LAYER_ID,
        type: 'circle',
        source: STOP_SOURCE_ID,
        // Dots show from the visible zoom on, names from STOP_MIN_ZOOM.
        minzoom: config.lineVisibleZoom,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], config.lineVisibleZoom, 2, STOP_MIN_ZOOM, 4],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'colour'],
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: STOP_LABEL_ID,
        type: 'symbol',
        source: STOP_SOURCE_ID,
        minzoom: STOP_MIN_ZOOM,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top' },
        paint: { 'text-color': '#1d1d1f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      })
      // One round badge per line, carrying its ref in the line's colour, on the middle of its track.
      map.addLayer({
        id: BADGE_LAYER_ID,
        type: 'circle',
        source: BADGE_SOURCE_ID,
        minzoom: BADGE_MIN_ZOOM,
        paint: { 'circle-radius': 10, 'circle-color': ['get', 'colour'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
      })
      map.addLayer({
        id: BADGE_TEXT_ID,
        type: 'symbol',
        source: BADGE_SOURCE_ID,
        minzoom: BADGE_MIN_ZOOM,
        layout: { 'text-field': ['get', 'ref'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': ['get', 'textColour'] },
      })
      // The mode, as a short word above the badge.
      map.addLayer({
        id: BADGE_MODE_ID,
        type: 'symbol',
        source: BADGE_SOURCE_ID,
        minzoom: BADGE_MIN_ZOOM,
        layout: { 'text-field': ['get', 'mode'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, -1.6], 'text-allow-overlap': true },
        paint: { 'text-color': '#5c5c63', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      })
      map.on('click', LAYER_ID, (event) => {
        const id = Number(event.features?.[0]?.properties?.relationId)
        if (Number.isFinite(id)) setSelectedId(id)
      })
      map.on('mouseenter', LAYER_ID, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', LAYER_ID, () => {
        map.getCanvas().style.cursor = ''
      })
      void loadLines()
    })
    map.on('moveend', () => {
      writeHash()
      publishVisible()
      clearTimeout(debounce)
      debounce = setTimeout(() => void loadLines(), MOVE_DEBOUNCE_MS)
    })
    map.on('error', (event) => console.error('MapLibre error:', event.error))
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    return () => {
      clearTimeout(debounce)
      controller?.abort()
      mapRef.current = null
      map.remove()
    }
  }, [setKnown, setSelectedId, setVisible])

  // A place or line chosen in the search moves the map there. The map then loads the lines of the new view.
  useEffect(() => {
    if (target) mapRef.current?.flyTo({ center: [target.lon, target.lat], zoom: target.zoom })
  }, [target])

  const selected = known.find((route) => route.id === selectedId)

  // Inline style: MapLibre's own stylesheet sets position: relative on the
  // container with the same specificity, which would collapse the map to 0px.
  return (
    <>
      <div ref={container} className="map" style={{ position: 'absolute', inset: 0 }} />
      {zoomedOut && <p className="zoom-hint">Zoom in to see lines.</p>}
      {loading && !zoomedOut && !loadError && <p className="zoom-hint">Loading lines…</p>}
      {waitSeconds !== null && (
        <p className="zoom-hint" role="status">
          Rate limited by OpenStreetMap, retrying in {waitSeconds} s.
        </p>
      )}
      {!zoomedOut && (
        <Button variant="outline" size="sm" className="absolute bottom-3 left-3 z-10 bg-card shadow-md" onClick={() => reload.current()}>
          Reload visible area
        </Button>
      )}
      {selected && (
        <LineCard line={selected} variants={lineVariants(known, selected.id)} onClose={() => setSelectedId(null)} />
      )}
      {loadError && (
        <div className="map-notice" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => retry.current()}>
            Try again
          </button>
        </div>
      )}
    </>
  )
}
