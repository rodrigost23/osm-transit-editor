import type { RouteSource, Stop } from '@/core/data/geojson'
import { lineColour, lineHeader } from '@/core/data/lines'
import { directionLabel, displayLineName, displayStopName } from '@/ui/format'
import { useState } from 'react'
import { Badge } from '@/ui/components/ui/badge'
import { Button } from '@/ui/components/ui/button'
import { Card } from '@/ui/components/ui/card'
import { cn } from '@/lib/utils'

interface LinePanelProps {
  line: RouteSource
  /** Every route of the line, one per direction. */
  variants: RouteSource[]
  selectedStopKey: string | null
  onChooseVariant: (variant: RouteSource) => void
  onChooseStop: (stop: Stop) => void
  onBack: () => void
}

/** A key/value table of OSM tags. Long values wrap, so the panel never scrolls sideways. */
function TagTable({ tags }: { tags: Record<string, string> }) {
  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No tags.</p>
  return (
    <table className="w-full table-fixed text-xs">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="align-top">
            <th className="w-2/5 py-0.5 pr-2 text-left font-medium break-all">{key}</th>
            <td className="py-0.5 break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function LinePanel({ line, variants, selectedStopKey, onChooseVariant, onChooseStop, onBack }: LinePanelProps) {
  const [showDetails, setShowDetails] = useState(false)
  const current = variants.find((variant) => variant.id === line.id) ?? line
  const header = lineHeader(line)
  const stops = (current.stops ?? []).filter((stop) => stop.name)
  return (
    <Card aria-label={displayLineName(header)} className="absolute top-4 bottom-4 left-4 z-10 flex w-[min(340px,calc(100%-32px))] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-xl">
      <header className="flex items-center gap-3 border-b border-border p-4">
        <span
          className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-sm font-bold text-white"
          style={{ background: lineColour(header) }}
        >
          {header.tags.ref || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{displayLineName(header)}</h2>
          {header.tags.operator && <p className="truncate text-xs text-muted-foreground">{header.tags.operator}</p>}
        </div>
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onBack}>
          ← Lines
        </Button>
      </header>
      {variants.length > 1 && (
        <div className="flex gap-1 border-b border-border p-2" role="group" aria-label="Direction">
          {variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              aria-pressed={variant.id === current.id}
              onClick={() => onChooseVariant(variant)}
              className={cn(
                'flex-1 cursor-pointer truncate rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors',
                variant.id === current.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {directionLabel(variant)}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Stations in route order</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((open) => !open)}
          >
            Details
          </Button>
          <Badge variant="outline" className="font-normal">
            {stops.length}
          </Badge>
        </div>
      </div>
      {showDetails && (
        <div className="max-h-56 min-w-0 space-y-3 overflow-y-auto border-b border-border px-4 pb-3">
          {line.master && (
            <section>
              <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                Route master (relation {line.master.id})
              </h3>
              <TagTable tags={line.master.tags} />
            </section>
          )}
          <section>
            <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Route (relation {current.id})</h3>
            <TagTable tags={current.tags} />
          </section>
        </div>
      )}
      {stops.length === 0 && <p className="px-4 pb-4 text-sm text-muted-foreground">No stations loaded for this direction.</p>}
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {stops.map((stop, index) => {
          const active = stop.key === selectedStopKey
          return (
            <li key={stop.key}>
              <button
                type="button"
                onClick={() => onChooseStop(stop)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted',
                  active && 'bg-muted font-semibold ring-1 ring-ring',
                )}
              >
                <span className="w-6 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="flex-1 truncate" title={stop.name}>{displayStopName(stop.name)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
