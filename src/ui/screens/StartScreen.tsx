import { useRef, useState, type FormEvent } from 'react'
import { config } from '@/core/config'
import { modeLabel, type RouteSource, type Stop } from '@/core/data/geojson'
import { groupLines, lineColour, lineVariants, routeCentre } from '@/core/data/lines'
import { searchPlace } from '@/core/data/nominatim'
import { describeError } from '@/core/data/route-loader'
import { MapView, type MapTarget } from '@/ui/map/MapView'
import { LinePanel } from '@/ui/map/LinePanel'
import { displayLineName } from '@/ui/format'
import { StationPanel } from '@/ui/map/StationPanel'
import { Badge } from '@/ui/components/ui/badge'
import { Button } from '@/ui/components/ui/button'
import { Card } from '@/ui/components/ui/card'

// A floating panel over the full-screen map. Place search goes to Nominatim on submit.
// The list shows the lines on screen, from the routes already loaded, so it needs no request.
export function StartScreen() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [target, setTarget] = useState<MapTarget | undefined>()
  const [known, setKnown] = useState<RouteSource[]>([])
  const [visible, setVisible] = useState<RouteSource[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const lines = groupLines(visible)
  const reloadRef = useRef<() => void>(() => {})
  const selectedRoute = known.find((route) => route.id === selectedId)
  const variants = selectedRoute ? lineVariants(known, selectedRoute.id) : []
  const stationList = selectedRoute ? (selectedRoute.stops ?? []).filter((stop) => stop.name) : []
  const stationIndex = selectedStop ? stationList.findIndex((stop) => stop.key === selectedStop.key) : -1

  // A station moves the map to it and opens its panel.
  const chooseStop = (stop: Stop) => {
    setSelectedStop(stop)
    setTarget({ lat: stop.lat, lon: stop.lon, zoom: 15, id: Date.now() })
  }


  // Picking a line opens its card and moves the map to the middle of the line.
  const chooseLine = (group: RouteSource[]) => {
    setSelectedStop(null)
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
        setKnown={setKnown}
        setSelectedId={setSelectedId}
        setVisible={setVisible}
        reloadRef={reloadRef}
      />
      {selectedRoute ? (
        <LinePanel
          line={selectedRoute}
          variants={variants}
          selectedStopKey={selectedStop?.key ?? null}
          onChooseVariant={(variant) => {
            setSelectedStop(null)
            setSelectedId(variant.id)
          }}
          onChooseStop={chooseStop}
          onBack={() => {
            setSelectedStop(null)
            setSelectedId(null)
          }}
        />
      ) : (
      <Card className="absolute top-4 left-4 z-10 w-[min(320px,calc(100vw-32px))] gap-0 p-4">
        <header className="mb-3 flex items-baseline justify-between">
          <span className="text-base font-semibold tracking-tight">OSM Transit Editor</span>
          <Badge variant="outline" className="font-normal">Read-only</Badge>
        </header>
        <form onSubmit={search} className="grid gap-1.5">
          <label htmlFor="place-search" className="text-xs font-medium text-muted-foreground">
            Go to a place
          </label>
          <input
            id="place-search"
            type="search"
            placeholder="e.g. Rio de Janeiro"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </form>
        <div className="mt-4 grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Lines on screen</span>
            <Button variant="ghost" size="sm" className="-my-1 -mr-2 h-7 px-2 text-xs text-muted-foreground" onClick={() => reloadRef.current()}>
              ↻ Reload
            </Button>
          </div>
          {lines.length === 0 && (
            <p className="text-[13px] text-muted-foreground">No lines on screen. Zoom in or pan to load some.</p>
          )}
          {lines.length > 0 && (
            <ul className="grid max-h-[40vh] gap-1.5 overflow-y-auto">
              {lines.map((group) => (
                <li key={group[0].id}>
                  <button
                    type="button"
                    onClick={() => chooseLine(group)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span
                      className="inline-flex min-w-7 justify-center rounded-md px-1.5 py-0.5 text-xs font-bold text-white"
                      style={{ background: lineColour(group[0]) }}
                    >
                      {group[0].tags.ref || '?'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{displayLineName(group[0])}</span>
                      <span className="block truncate text-xs text-muted-foreground">{modeLabel(group[0])}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {status && (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            {status}
          </p>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Place search by Nominatim. Map data © OpenStreetMap contributors.
        </p>
      </Card>
      )}
      {selectedRoute && selectedStop && stationIndex >= 0 && (
        <StationPanel
          stop={selectedStop}
          position={stationIndex + 1}
          total={stationList.length}
          onClose={() => setSelectedStop(null)}
        />
      )}
    </>
  )
}
