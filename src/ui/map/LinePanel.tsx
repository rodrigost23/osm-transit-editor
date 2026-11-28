import type { RouteSource, Stop } from '@/core/data/geojson'
import { lineColour, lineName } from '@/core/data/lines'
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

// Direction label: "to" is where the route goes, which is what a rider looks for.
function directionLabel(route: RouteSource): string {
  return route.tags.to ? `→ ${route.tags.to}` : lineName(route)
}

export function LinePanel({ line, variants, selectedStopKey, onChooseVariant, onChooseStop, onBack }: LinePanelProps) {
  const current = variants.find((variant) => variant.id === line.id) ?? line
  const stops = (current.stops ?? []).filter((stop) => stop.name)
  return (
    <Card aria-label={lineName(line)} className="absolute top-4 bottom-4 left-4 z-10 flex w-[min(340px,calc(100%-32px))] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-xl">
      <header className="flex items-center gap-3 border-b border-border p-4">
        <span
          className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-sm font-bold text-white"
          style={{ background: lineColour(line) }}
        >
          {line.tags.ref || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{lineName(line)}</h2>
          {line.tags.operator && <p className="truncate text-xs text-muted-foreground">{line.tags.operator}</p>}
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
                'flex-1 cursor-pointer truncate rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                variant.id === current.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {directionLabel(variant)}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Stations in route order</span>
        <Badge variant="outline" className="font-normal">
          {stops.length}
        </Badge>
      </div>
      {stops.length === 0 && <p className="px-4 pb-4 text-sm text-muted-foreground">No stations loaded for this direction.</p>}
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {stops.map((stop, index) => {
          const active = stop.key === selectedStopKey
          return (
            <li key={stop.key}>
              <button
                type="button"
                onClick={() => onChooseStop(stop)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                  active && 'bg-muted font-semibold ring-1 ring-ring',
                )}
              >
                <span className="w-6 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="flex-1 truncate">{stop.name}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
