import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { config } from '@/core/config'

export function MapView() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const { lat, lon, zoom } = config.initialView
    const map = new maplibregl.Map({
      container: container.current,
      style: config.basemapStyleUrl,
      center: [lon, lat],
      zoom,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    return () => map.remove()
  }, [])

  return <div ref={container} className="map" />
}
