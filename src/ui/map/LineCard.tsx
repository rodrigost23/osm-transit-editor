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
  return (
    <Card aria-label={lineName(line)} className="absolute bottom-4 left-4 z-10 max-h-1/2 w-[min(320px,calc(100%-32px))] gap-0 overflow-auto p-4">
      <header className="flex items-center gap-2.5">
        <span
          className="min-w-7 rounded-md px-1.5 py-0.5 text-center text-xs font-bold text-white"
          style={{ background: lineColour(line) }}
        >
          {ref || '?'}
        </span>
        <strong className="text-sm font-semibold leading-snug">{lineName(line)}</strong>
        <Button variant="ghost" size="sm" className="-mr-2 ml-auto h-7 w-7 p-0 text-lg" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </header>
      {line.tags.operator && <p className="mt-1 text-xs text-muted-foreground">{line.tags.operator}</p>}
      <ul className="mt-2 divide-y divide-border">
        {variants.map((variant) => (
          <li key={variant.id} className="py-1.5 text-sm text-muted-foreground">
            {variant.tags.from && variant.tags.to ? `${variant.tags.from} → ${variant.tags.to}` : lineName(variant)}
          </li>
        ))}
      </ul>
    </Card>
  )
}
