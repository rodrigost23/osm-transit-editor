import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'
import {
  badgesToGeoJSON,
  linesToGeoJSON,
  RouteChangeTracker,
  sharedStationsToGeoJSON,
  stopsToGeoJSON,
  type PointCollection,
  type RouteCollection,
  type RouteSource,
} from '@/core/data/geojson'
import { IndexedDbStore } from '@/core/data/idb-store'
import { lineKey, routesInView } from '@/core/data/lines'
import { describeError, RouteLoader } from '@/core/data/route-loader'
import { LayeredStore, MemoryStore } from '@/core/data/store'
import { formatHash, parseHash } from '@/core/map/position'
import { LOCATE_TIMEOUT_MS, LOCATE_ZOOM, locateErrorMessage } from '@/core/map/locate'
import { baseStyleUrl } from './base-style'
import { ensurePillImage } from './station-pill'
import {
  emphasize,
  hoveredLineMatch,
  hoveredStationMatch,
  isActive,
  litLines,
  litStations,
  opacityFor,
  type Highlight,
  type NumberPaint,
} from './highlight'

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
const STOP_ALL_LAYER_ID = 'transit-stops-all-circle'
const STOP_LABEL_ID = 'transit-stops-name'
// Layers a pointer can hover: the lines, their badges and the stations.
const HOVER_LAYERS = [LAYER_ID, OVERVIEW_LAYER_ID, BADGE_LAYER_ID, STOP_LAYER_ID, STOP_ALL_LAYER_ID]
// Stations served by two lines are drawn as a pill over their dot, with the colour of each line.
const PILL_SOURCE_ID = 'transit-shared-stations'
const PILL_LAYER_ID = 'transit-shared-stations-pill'
// Badges are too crowded to read below this zoom.
const BADGE_MIN_ZOOM = 12
// Stations are drawn, and named, from this zoom on.
const STOP_MIN_ZOOM = 14
// The radius of a station dot, growing from the lowest visible zoom to STOP_MIN_ZOOM.
const STOP_RADIUS_ZOOMED: NumberPaint = ['interpolate', ['linear'], ['zoom'], config.lineVisibleZoom, 2, STOP_MIN_ZOOM, 4]
// Wait for the map to settle before querying, so a fast pan or zoom sends one request.
const MOVE_DEBOUNCE_MS = 400
// The locate button sits in the navigation control's corner, under the zoom and compass buttons.
class LocateControl implements maplibregl.IControl {
  private container: HTMLDivElement | null = null
  private button: HTMLButtonElement | null = null

  private readonly onLocate: () => void
  private readonly isLocating: () => boolean

  constructor(onLocate: () => void, isLocating: () => boolean) {
    this.onLocate = onLocate
    this.isLocating = isLocating
  }

  onAdd(): HTMLElement {
    this.container = document.createElement('div')
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.title = 'Show my location'
    this.button.setAttribute('aria-label', 'Show my location')
    this.button.className = 'locate-button'
    this.button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>' +
      '<path d="M12 1v3M12 20v3M1 12h3M20 12h3"/></svg>'
    this.button.addEventListener('click', () => {
      if (!this.isLocating()) this.onLocate()
    })
    this.container.appendChild(this.button)
    return this.container
  }

  onRemove(): void {
    this.container?.remove()
    this.container = null
    this.button = null
  }

  setBusy(busy: boolean): void {
    if (this.button) this.button.disabled = busy
  }
}

const emptyRoutes: RouteCollection = { type: 'FeatureCollection', features: [] }
const emptyPoints: PointCollection = { type: 'FeatureCollection', features: [] }

interface MapViewProps {
  target?: MapTarget
  setKnown: Dispatch<SetStateAction<RouteSource[]>>
  setSelectedId: Dispatch<SetStateAction<number | null>>
  /** The line key of the selected line, or null. The other lines and stations are faded. */
  selectedKey: string | null
  /** The line key under the pointer in the list, or null. Lit like a line hovered on the map. */
  hoveredKey: string | null
  /** Set when the pointer moves onto or off a line on the map. */
  setHoveredLine: Dispatch<SetStateAction<string | null>>
  /** The routes with a point in the visible area, for the list of lines on screen. */
  setVisible: Dispatch<SetStateAction<RouteSource[]>>
  /** Set by the map to reload the visible area. The panel calls it from its own button. */
  reloadRef: { current: () => void }
}

export function MapView({ target, setKnown, setSelectedId, selectedKey, hoveredKey, setHoveredLine, setVisible, reloadRef }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  // The selection and the restyling of the layers for it, which the map effect sets up once the map exists.
  const selectedKeyRef = useRef<string | null>(selectedKey)
  const hoveredKeyRef = useRef<string | null>(hoveredKey)
  const applyHighlight = useRef<() => void>(() => {})
  const retry = useRef<() => void>(() => {})
  // Seconds until the OSM API is asked again after a rate limit, or null when no cooldown is running.
  const [waitSeconds, setWaitSeconds] = useState<number | null>(null)
  const [zoomedOut, setZoomedOut] = useState(false)
  const [loading, setLoading] = useState(false)
  // What went wrong with the last load, or null when everything in view loaded.
  const [loadError, setLoadError] = useState<string | null>(null)
  // What went wrong with the last locate request, or null.
  const [locateError, setLocateError] = useState<string | null>(null)

  useEffect(() => {
    selectedKeyRef.current = selectedKey
    hoveredKeyRef.current = hoveredKey
    applyHighlight.current()
  }, [selectedKey, hoveredKey])

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
    // The routes last drawn, so the stations can move with their lanes when the zoom changes.
    let shownRoutes: RouteSource[] = []
    // The routes on screen, from the routes loaded so far.
    const publishVisible = () => {
      const bounds = map.getBounds()
      setVisible(
        routesInView([...seen.values()], { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() }),
      )
    }
    const loader = new RouteLoader(config.osmApiUrl, {
      overpassUrls: config.overpassUrls,
      store: new LayeredStore(new MemoryStore(300), new IndexedDbStore()),
      onCooldown: (until) => setWaitSeconds(Math.ceil((until - Date.now()) / 1000)),
    })
    let debounce: ReturnType<typeof setTimeout> | undefined
    const loadLines = async (refresh = false) => {
      const source = map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)
      if (!source) return
      const badges = map.getSource<maplibregl.GeoJSONSource>(BADGE_SOURCE_ID)
      const stops = map.getSource<maplibregl.GeoJSONSource>(STOP_SOURCE_ID)
      const pills = map.getSource<maplibregl.GeoJSONSource>(PILL_SOURCE_ID)
      const overview = map.getSource<maplibregl.GeoJSONSource>(OVERVIEW_SOURCE_ID)
      // Lines, badges and stations come from the same routes, so they are set together.
      const show = (routes: RouteSource[], next: RouteCollection) => {
        source.setData(next)
        overview?.setData(linesToGeoJSON(routes, map.getZoom()))
        badges?.setData(badgesToGeoJSON(routes))
        shownRoutes = routes
        stops?.setData(stopsToGeoJSON(routes, map.getZoom()))
        const shared = sharedStationsToGeoJSON(routes, map.getZoom())
        for (const station of shared.features) ensurePillImage(map, station.properties.colourA, station.properties.colourB)
        pills?.setData(shared)
        publishVisible()
      }
      controller?.abort()
      // Between overpassLineZoom and minLineZoom, lines come from the Overpass mirrors in one query per view.
      const viaMirrors =
        map.getZoom() < config.minLineZoom && map.getZoom() >= config.overpassLineZoom && config.overpassUrls.length > 0
      if (map.getZoom() < config.minLineZoom && !viaMirrors) {
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
          { refresh, overpassFirst: viaMirrors },
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
    reloadRef.current = () => void loadLines(true)

    // Keep the position in the hash so a reload or a shared link opens the same place.
    // replaceState does not fire hashchange, so this does not loop.
    const writeHash = () => {
      const center = map.getCenter()
      const hash = formatHash({ lat: center.lat, lon: center.lng, zoom: map.getZoom() })
      window.history.replaceState(null, '', hash)
    }

    // Hover is kept here and read by applyHighlight, which restyles the layers. Nothing is redrawn.
    // The line last reported to the parent, and the station under the pointer with the lines serving it.
    let reportedLine: string | null = null
    let hoverName: string | null = null
    let hoverStationLines: string[] = []
    applyHighlight.current = () => {
      // The layers exist once the style has loaded; until then there is nothing to restyle.
      if (!map.getLayer(LAYER_ID)) return
      const highlight: Highlight = {
        selectedKey: selectedKeyRef.current,
        hoverLines: [...new Set([...(hoveredKeyRef.current ? [hoveredKeyRef.current] : []), ...hoverStationLines])],
        hoverName,
      }
      const active = isActive(highlight)
      const lineOpacity = opacityFor(active, litLines(highlight))
      const stationOpacity = opacityFor(active, litStations(highlight))
      const lineMatch = hoveredLineMatch(highlight)
      const stationMatch = hoveredStationMatch(highlight)
      map.setPaintProperty(OVERVIEW_LAYER_ID, 'line-opacity', lineOpacity)
      map.setPaintProperty(OVERVIEW_LAYER_ID, 'line-width', emphasize(3, 3, lineMatch))
      map.setPaintProperty(CASING_LAYER_ID, 'line-opacity', lineOpacity)
      map.setPaintProperty(CASING_LAYER_ID, 'line-width', emphasize(9, 3, lineMatch))
      map.setPaintProperty(LAYER_ID, 'line-opacity', lineOpacity)
      map.setPaintProperty(LAYER_ID, 'line-width', emphasize(6, 3, lineMatch))
      map.setPaintProperty(BADGE_LAYER_ID, 'circle-opacity', lineOpacity)
      map.setPaintProperty(BADGE_LAYER_ID, 'circle-stroke-opacity', lineOpacity)
      map.setPaintProperty(BADGE_LAYER_ID, 'circle-radius', emphasize(10, 2, lineMatch))
      map.setPaintProperty(BADGE_TEXT_ID, 'text-opacity', lineOpacity)
      map.setPaintProperty(BADGE_MODE_ID, 'text-opacity', lineOpacity)
      map.setPaintProperty(PILL_LAYER_ID, 'icon-opacity', stationOpacity)
      map.setPaintProperty(STOP_LAYER_ID, 'circle-opacity', stationOpacity)
      map.setPaintProperty(STOP_LAYER_ID, 'circle-stroke-opacity', stationOpacity)
      map.setPaintProperty(STOP_LAYER_ID, 'circle-radius', emphasize(STOP_RADIUS_ZOOMED, 2, stationMatch))
      map.setPaintProperty(STOP_ALL_LAYER_ID, 'circle-opacity', stationOpacity)
      map.setPaintProperty(STOP_ALL_LAYER_ID, 'circle-stroke-opacity', stationOpacity)
      map.setPaintProperty(STOP_ALL_LAYER_ID, 'circle-radius', emphasize(4, 2, stationMatch))
      map.setPaintProperty(STOP_LABEL_ID, 'text-opacity', stationOpacity)
    }

    // Stations move with their lanes below zoom 14, so they are placed again at each zoom.
    map.on('zoomend', () => {
      map.getSource<maplibregl.GeoJSONSource>(STOP_SOURCE_ID)?.setData(stopsToGeoJSON(shownRoutes, map.getZoom()))
      if (shownRoutes.length > 0) map.getSource<maplibregl.GeoJSONSource>(OVERVIEW_SOURCE_ID)?.setData(linesToGeoJSON(shownRoutes, map.getZoom()))
      const shared = sharedStationsToGeoJSON(shownRoutes, map.getZoom())
      for (const station of shared.features) ensurePillImage(map, station.properties.colourA, station.properties.colourB)
      map.getSource<maplibregl.GeoJSONSource>(PILL_SOURCE_ID)?.setData(shared)
    })
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
        // Lines sharing a track are offset sideways, so they run side by side.
        paint: { 'line-color': ['get', 'colour'], 'line-width': 3 },
      })
      map.addSource(BADGE_SOURCE_ID, { type: 'geojson', data: emptyPoints })
      map.addSource(STOP_SOURCE_ID, { type: 'geojson', data: emptyPoints })
      map.addSource(PILL_SOURCE_ID, { type: 'geojson', data: emptyPoints })
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
      // Stations sit under the badges. Zoomed out, one dot per station; from STOP_MIN_ZOOM on, one dot
      // per stop, so a station served by parallel tracks shows a dot on each.
      map.addLayer({
        id: STOP_LAYER_ID,
        type: 'circle',
        source: STOP_SOURCE_ID,
        minzoom: config.lineVisibleZoom,
        maxzoom: STOP_MIN_ZOOM,
        filter: ['==', ['get', 'primary'], 'true'],
        paint: {
          'circle-radius': STOP_RADIUS_ZOOMED,
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'colour'],
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: PILL_LAYER_ID,
        type: 'symbol',
        source: PILL_SOURCE_ID,
        minzoom: config.lineVisibleZoom,
        maxzoom: STOP_MIN_ZOOM,
        layout: {
          'icon-image': ['concat', 'station-pill-', ['get', 'colourA'], '-', ['get', 'colourB']],
          // The shape lies across the track, at the angle of the track at the station.
          'icon-rotate': ['get', 'angle'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      map.addLayer({
        id: STOP_ALL_LAYER_ID,
        type: 'circle',
        source: STOP_SOURCE_ID,
        minzoom: STOP_MIN_ZOOM,
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'colour'],
          'circle-stroke-width': 2,
        },
      })
      // Names are set on the first stop of each name only, so a station is named once.
      map.addLayer({
        id: STOP_LABEL_ID,
        type: 'symbol',
        source: STOP_SOURCE_ID,
        minzoom: STOP_MIN_ZOOM,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top' },
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
      // Clicking a line selects it, and clicking the selected line again clears the selection.
      map.on('click', [LAYER_ID, OVERVIEW_LAYER_ID], (event) => {
        const id = Number(event.features?.[0]?.properties?.relationId)
        if (!Number.isFinite(id)) return
        setSelectedId((current) => {
          const selectedRoute = current === null ? undefined : seen.get(current)
          const route = seen.get(id)
          return selectedRoute && route && lineKey(selectedRoute) === lineKey(route) ? null : id
        })
      })
      // A click on empty map clears the selection. Clicks on lines, stations and badges do not.
      map.on('click', (event) => {
        const layers = [...HOVER_LAYERS, PILL_LAYER_ID, STOP_LABEL_ID, BADGE_TEXT_ID, BADGE_MODE_ID].filter((id) => map.getLayer(id))
        if (map.queryRenderedFeatures(event.point, { layers }).length === 0) setSelectedId(null)
      })
      // Hovering a line, badge or station highlights it and shows a pointer. A line is also reported to
      // the parent, which highlights its item in the list.
      map.on('mousemove', (event) => {
        const layers = HOVER_LAYERS.filter((id) => map.getLayer(id))
        const hit = layers.length > 0 ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined
        const isStation = hit?.layer.id === STOP_LAYER_ID || hit?.layer.id === STOP_ALL_LAYER_ID
        const key = hit?.properties.lineKey
        const name = hit?.properties.name
        const stationLines = hit?.properties.lines
        const nextLine = hit && !isStation && typeof key === 'string' ? key : null
        const nextName = hit && isStation && typeof name === 'string' && name !== '' ? name : null
        const nextStationLines = nextName !== null && Array.isArray(stationLines) ? stationLines.map(String) : []
        map.getCanvas().style.cursor = hit ? 'pointer' : ''
        if (nextLine === reportedLine && nextName === hoverName) return
        reportedLine = nextLine
        hoverName = nextName
        hoverStationLines = nextStationLines
        setHoveredLine(nextLine)
        applyHighlight.current()
      })
      map.on('mouseout', () => {
        if (reportedLine === null && hoverName === null) return
        reportedLine = null
        hoverName = null
        hoverStationLines = []
        setHoveredLine(null)
        applyHighlight.current()
      })
      applyHighlight.current()
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

    // The position is asked for only on a click, never on load. The marker is a small dot, not a pin.
    let locating = false
    let marker: maplibregl.Marker | null = null
    let closed = false
    const locateControl = new LocateControl(
      () => {
        if (!navigator.geolocation) {
          setLocateError('Location is not available in this browser.')
          return
        }
        locating = true
        locateControl.setBusy(true)
        setLocateError(null)
        navigator.geolocation.getCurrentPosition(
          (position) => {
            locating = false
            locateControl.setBusy(false)
            if (closed) return
            const { latitude: lat, longitude: lon } = position.coords
            if (!marker) {
              const element = document.createElement('div')
              element.className = 'locate-marker'
              element.setAttribute('aria-label', 'Your position')
              marker = new maplibregl.Marker({ element }).setLngLat([lon, lat]).addTo(map)
            } else {
              marker.setLngLat([lon, lat])
            }
            map.flyTo({ center: [lon, lat], zoom: LOCATE_ZOOM })
          },
          (error) => {
            locating = false
            locateControl.setBusy(false)
            if (closed) return
            setLocateError(locateErrorMessage(error.code))
          },
          { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: 60_000 },
        )
      },
      () => locating,
    )
    map.addControl(locateControl, 'top-right')
    return () => {
      closed = true
      clearTimeout(debounce)
      controller?.abort()
      mapRef.current = null
      marker?.remove()
      map.remove()
    }
  }, [setKnown, setSelectedId, setHoveredLine, setVisible, reloadRef])

  // A place or line chosen in the search moves the map there. The map then loads the lines of the new view.
  useEffect(() => {
    if (target) mapRef.current?.flyTo({ center: [target.lon, target.lat], zoom: target.zoom })
  }, [target])


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
      {locateError && (
        <p className="zoom-hint" role="alert">
          {locateError}
        </p>
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
