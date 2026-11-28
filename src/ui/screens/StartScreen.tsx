import { useState, type FormEvent } from 'react'
import { config } from '@/core/config'
import { modeLabel, type RouteSource } from '@/core/data/geojson'
import { groupLines, lineColour, lineName, routeCentre } from '@/core/data/lines'
import { searchPlace } from '@/core/data/nominatim'
import { describeError } from '@/core/data/route-loader'
import { MapView, type MapTarget } from '@/ui/map/MapView'

// A floating panel over the full-screen map. Place search goes to Nominatim on submit.
// The list shows the lines on screen, from the routes already loaded, so it needs no request.
export function StartScreen() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [target, setTarget] = useState<MapTarget | undefined>()
  const [known, setKnown] = useState<RouteSource[]>([])
  const [visible, setVisible] = useState<RouteSource[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const lines = groupLines(visible)

  // Picking a line opens its card and moves the map to the middle of the line.
  const chooseLine = (group: RouteSource[]) => {
    setSelectedId(group[0].id)
    const centre = routeCentre(group[0])
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
      <MapView
        target={target}
        known={known}
        setKnown={setKnown}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        setVisible={setVisible}
      />
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
          <span className="start-label">Lines on screen</span>
          {lines.length === 0 && <p className="start-note">No lines on screen. Zoom in or pan to load some.</p>}
          {lines.length > 0 && (
            <ul className="line-results">
              {lines.map((group) => (
                <li key={group[0].id}>
                  <button type="button" onClick={() => chooseLine(group)}>
                    <span className="line-badge" style={{ background: lineColour(group[0]) }}>
                      {group[0].tags.ref || '?'}
                    </span>
                    <span>{lineName(group[0])}</span>
                    <span className="line-mode">{modeLabel(group[0])}</span>
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
