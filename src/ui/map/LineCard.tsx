import { lineColour, lineName } from '@/core/data/lines'
import type { RouteSource } from '@/core/data/geojson'
import { Button } from '@/ui/components/ui/button'
import { Card } from '@/ui/components/ui/card'

interface LineCardProps {
  line: RouteSource
  /** Every loaded route of this line, one per direction. */
  variants: RouteSource[]
  onClose: () => void
}

export function LineCard({ line, variants, onClose }: LineCardProps) {
  const ref = line.tags.ref ?? ''
  // Several routes can share one direction; list each direction once.
  const directions = [...new Set(variants.map((v) => (v.tags.from && v.tags.to ? `${v.tags.from} → ${v.tags.to}` : lineName(v))))]
  return (
    <Card aria-label={lineName(line)} className="absolute bottom-3 left-3 z-10 max-h-1/2 w-[min(340px,calc(100%-24px))] gap-0 overflow-auto rounded-2xl p-0 shadow-xl">
      <header className="flex items-start gap-3 border-b border-border p-4">
        <span
          className="mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-sm font-bold text-white"
          style={{ background: lineColour(line) }}
        >
          {ref || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-snug font-semibold">{lineName(line)}</h2>
          {line.tags.operator && <p className="mt-0.5 text-xs text-muted-foreground">{line.tags.operator}</p>}
        </div>
        <Button variant="ghost" size="sm" className="-mt-1 -mr-2 h-8 w-8 p-0 text-lg text-muted-foreground" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </header>
      <div className="p-2">
        <p className="px-2 pt-1 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Directions</p>
        <ul className="grid gap-1">
          {directions.map((direction) => (
            <li key={direction} className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
              {direction}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
