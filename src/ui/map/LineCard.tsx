import { lineColour, lineName } from '@/core/data/lines'
import type { RouteSource } from '@/core/data/geojson'

interface LineCardProps {
  line: RouteSource
  /** Every loaded route of this line, one per direction. */
  variants: RouteSource[]
  onClose: () => void
}

export function LineCard({ line, variants, onClose }: LineCardProps) {
  const ref = line.tags.ref ?? ''
  return (
    <section className="line-card" aria-label={lineName(line)}>
      <header>
        <span className="line-badge" style={{ background: lineColour(line) }}>
          {ref || '?'}
        </span>
        <strong>{lineName(line)}</strong>
        <button type="button" className="line-card-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {line.tags.operator && <p className="line-card-meta">{line.tags.operator}</p>}
      <ul>
        {variants.map((variant) => (
          <li key={variant.id}>
            {variant.tags.from && variant.tags.to ? `${variant.tags.from} → ${variant.tags.to}` : lineName(variant)}
          </li>
        ))}
      </ul>
    </section>
  )
}
