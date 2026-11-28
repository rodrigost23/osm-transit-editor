import type { Stop } from '@/core/data/geojson'
import { Badge } from '@/ui/components/ui/badge'
import { Card } from '@/ui/components/ui/card'

interface StationPanelProps {
  stop: Stop
  /** 1-based position of the station in the route. */
  position: number
  total: number
  onClose: () => void
}

export function StationPanel({ stop, position, total, onClose }: StationPanelProps) {
  const osmId = stop.key.slice(1)
  const kind = stop.key.startsWith('w') ? 'way' : 'node'
  return (
    <Card aria-label={stop.name} className="absolute top-16 right-4 z-10 w-[min(300px,calc(100%-32px))] gap-0 rounded-2xl p-4 shadow-xl">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">{stop.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Station {position} of {total}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mt-1 -mr-1 cursor-pointer rounded-md px-2 text-lg text-muted-foreground hover:bg-muted"
        >
          ×
        </button>
      </div>
      <div className="mt-4 grid gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">In this route</span>
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <span>Stop</span>
          <Badge variant="outline" className="font-normal tabular-nums">
            {kind} {osmId}
          </Badge>
        </div>
      </div>
    </Card>
  )
}
