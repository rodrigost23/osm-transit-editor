import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'
import { RouteChangeTracker, type RouteCollection, type RouteSource } from '@/core/data/geojson'
import { IndexedDbStore } from '@/core/data/idb-store'
import { lineVariants } from '@/core/data/lines'
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
const LAYER_ID = 'transit-routes-line'
const LABEL_ID = 'transit-routes-label'
// Refs are too crowded to read below this zoom.
const LABEL_MIN_ZOOM = 12
// Wait for the map to settle before querying, so a fast pan or zoom sends one request.
const MOVE_DEBOUNCE_MS = 400
const emptyRoutes: RouteCollection = { type: 'FeatureCollection', features: [] }

interface MapViewProps {
  target?: MapTarget
  /** Every route loaded so far. The parent keeps it, so it can search them. */
  known: RouteSource[]
  setKnown: Dispatch<SetStateAction<RouteSource[]>>
  /** The line the user picked, on the map or in the search. */
  selectedId: number | null
  setSelectedId: Dispatch<SetStateAction<number | null>>
}

export function MapView({ target, known, setKnown, selectedId, setSelectedId }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const retry = useRef<() => void>(() => {})
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
    const loader = new RouteLoader(config.osmApiUrl, {
      store: new LayeredStore(new MemoryStore(300), new IndexedDbStore()),
    })
    let debounce: ReturnType<typeof setTimeout> | undefined
    const loadLines = async () => {
      const source = map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)
      if (!source) return
      controller?.abort()
      if (map.getZoom() < config.minLineZoom) {
        // Zoomed out, nothing is requested. Lines loaded so far stay on the map.
        const next = drawn.next([...seen.values()])
        if (next) source.setData(next)
        setZoomedOut(map.getZoom() < config.lineVisibleZoom)
        setLoading(false)
        setLoadError(null)
        return
      }
      setZoomedOut(false)
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
          if (next) source.setData(next)
        }
        const result = await loader.load(
          { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() },
          current.signal,
          (partial) => draw(partial.routes),
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
      } catch (error) {
        if (current.signal.aborted) return
        console.error('Could not load subway routes:', error)
        setLoading(false)
        setLoadError(`Could not load lines: ${describeError(error)}.`)
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
        minzoom: config.lineVisibleZoom,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': 4 },
      })
      // The ref is drawn along each line, in the line's colour as a halo.
      map.addLayer({
        id: LABEL_ID,
        type: 'symbol',
        source: SOURCE_ID,
        minzoom: LABEL_MIN_ZOOM,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'ref'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
        paint: { 'text-color': '#ffffff', 'text-halo-color': ['get', 'colour'], 'text-halo-width': 2 },
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
  }, [setKnown, setSelectedId])

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
