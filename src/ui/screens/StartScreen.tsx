import { useState, type FormEvent } from 'react'
import { config } from '@/core/config'
import { searchPlace } from '@/core/data/nominatim'
import { describeError } from '@/core/data/route-loader'
import { MapView, type MapTarget } from '@/ui/map/MapView'

// A floating panel over the full-screen map. Place search is wired; line search comes next.
export function StartScreen() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [target, setTarget] = useState<MapTarget | undefined>()

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
      <MapView target={target} />
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
          <label htmlFor="line-search">Find a line</label>
          <input id="line-search" type="search" placeholder="Name, ref or operator" disabled />
        </form>
        {status && <p className="start-note" role="status">{status}</p>}
        <p className="start-note">Place search by Nominatim. Map data © OpenStreetMap contributors.</p>
      </section>
    </>
  )
}
