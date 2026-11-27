import { MapView } from '@/ui/map/MapView'

// A floating panel over the full-screen map. Search and place fields are not wired yet.
export function StartScreen() {
  return (
    <>
      <MapView />
      <section className="start-panel" aria-label="Find a transit line">
        <header className="start-header">
          <span className="app-name">OSM Transit Editor</span>
          <span className="read-only">Read-only</span>
        </header>
        <form className="start-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="place-search">Go to a place</label>
          <input id="place-search" type="search" placeholder="e.g. Rio de Janeiro" disabled />
          <label htmlFor="line-search">Find a line</label>
          <input id="line-search" type="search" placeholder="Name, ref or operator" disabled />
        </form>
        <p className="start-note">Search is not available yet.</p>
      </section>
    </>
  )
}
