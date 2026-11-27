import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'
import { baseStyleUrl } from './base-style'

// MapLibre 6 resolves its worker next to its own module, which a bundler does
// not emit. Pointing it at the bundled asset keeps the worker under the base path.
maplibregl.setWorkerUrl(workerUrl)

export function MapView() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const { lat, lon, zoom } = config.initialView
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyleUrl,
      center: [lon, lat],
      zoom,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    return () => map.remove()
  }, [])

  return <div ref={container} className="map" />
}
