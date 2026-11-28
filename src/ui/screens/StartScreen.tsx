import { useState, type FormEvent } from 'react'
import { config } from '@/core/config'
import type { RouteSource } from '@/core/data/geojson'
import { lineColour, lineName, routeCentre, searchLines } from '@/core/data/lines'
import { searchPlace } from '@/core/data/nominatim'
import { describeError } from '@/core/data/route-loader'
import { MapView, type MapTarget } from '@/ui/map/MapView'

// A floating panel over the full-screen map. Place search goes to Nominatim on submit;
// line search runs on the routes already loaded in this session, so it needs no request.
export function StartScreen() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [target, setTarget] = useState<MapTarget | undefined>()
  const [known, setKnown] = useState<RouteSource[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [lineQuery, setLineQuery] = useState('')
  const lineResults = searchLines(known, lineQuery)

  // Picking a line opens its card and moves the map to the middle of the line.
  const chooseLine = (route: RouteSource) => {
    setSelectedId(route.id)
    const centre = routeCentre(route)
    if (centre) setTarget({ ...centre, zoom: 13, id: Date.now() })
  }

  // Nominatim is asked only when the user submits, never while typing.
  const search = async (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) return
    setStatus('Searching…')
    try {
      const place = await searchPlace(text, config.nominatimUrl)
      if (!place) {
        setStatus('No place found.')
        return
      }
      setTarget({ lat: place.lat, lon: place.lon, zoom: 13, id: Date.now() })
      setStatus(place.name)
    } catch (error) {
      console.error('Place search failed:', error)
      setStatus(`Search failed: ${describeError(error)}.`)
    }
  }

  return (
    <>
      <MapView target={target} known={known} setKnown={setKnown} selectedId={selectedId} setSelectedId={setSelectedId} />
      <section className="start-panel" aria-label="Find a transit line">
        <header className="start-header">
          <span className="app-name">OSM Transit Editor</span>
          <span className="read-only">Read-only</span>
        </header>
        <form className="start-form" onSubmit={search}>
          <label htmlFor="place-search">Go to a place</label>
          <input
            id="place-search"
            type="search"
            placeholder="e.g. Rio de Janeiro"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>
        <div className="start-form">
          <label htmlFor="line-search">Find a line</label>
          <input
            id="line-search"
            type="search"
            placeholder="Name, ref or operator"
            value={lineQuery}
            onChange={(event) => setLineQuery(event.target.value)}
          />
          {lineQuery.trim() && lineResults.length === 0 && (
            <p className="start-note">No loaded line matches. Pan or zoom the map to load more.</p>
          )}
          {lineResults.length > 0 && (
            <ul className="line-results">
              {lineResults.map((route) => (
                <li key={route.id}>
                  <button type="button" onClick={() => chooseLine(route)}>
                    <span className="line-badge" style={{ background: lineColour(route) }}>
                      {route.tags.ref || '?'}
                    </span>
                    <span>{lineName(route)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {status && <p className="start-note" role="status">{status}</p>}
        <p className="start-note">Place search by Nominatim. Map data © OpenStreetMap contributors.</p>
      </section>
    </>
  )
}
