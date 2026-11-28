/**
 * Paint expressions for hovering and selecting lines and stations. The map restyles its layers with
 * these, so a hover or a selection never redraws a source. Each feature carries `lineKey` (line-like
 * features), `lines` (stations, the line keys of the lines serving them) and `name` (stations).
 */

import type { DataDrivenPropertyValueSpecification } from 'maplibre-gl'

/** A number-valued paint property that may be an expression. */
export type NumberPaint = DataDrivenPropertyValueSpecification<number>

/** Opacity of the lines and stations that are not selected, while a line is selected. */
export const DIMMED_OPACITY = 0.15

/** A MapLibre expression, before it is typed as a paint value. */
export type PaintExpression = unknown[]

function asPaint(expression: PaintExpression): NumberPaint {
  return expression as unknown as NumberPaint
}

/** Full opacity for what the selection or the hover lights, dimmed for the rest. */
export function opacityFor(selectedKey: string | null, lit: PaintExpression[]): NumberPaint {
  if (selectedKey === null) return 1
  return asPaint(['case', ['any', ...lit], 1, DIMMED_OPACITY])
}

/** Conditions that light a line-like feature: it belongs to the selected line, or it is hovered. */
export function litLines(selectedKey: string | null, hoveredKey: string | null): PaintExpression[] {
  const lit: PaintExpression[] = []
  if (selectedKey !== null) lit.push(['==', ['get', 'lineKey'], selectedKey])
  if (hoveredKey !== null) lit.push(['==', ['get', 'lineKey'], hoveredKey])
  return lit
}

/** Conditions that light a station: one of the selected line's stations, or the hovered station. */
export function litStations(selectedKey: string | null, hoveredName: string | null): PaintExpression[] {
  const lit: PaintExpression[] = []
  if (selectedKey !== null) lit.push(['in', selectedKey, ['get', 'lines']])
  if (hoveredName !== null) lit.push(['==', ['get', 'name'], hoveredName])
  return lit
}

/** A value that grows by `bump` on the features matching `matches`, and keeps `base` on the rest. */
export function emphasize(base: NumberPaint, bump: number, matches: PaintExpression | null): NumberPaint {
  if (matches === null) return base
  return asPaint(['case', matches, ['+', base, bump], base])
}
