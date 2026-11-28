import type { DataDrivenPropertyValueSpecification } from 'maplibre-gl'

/**
 * Paint expressions for hovering and selecting lines and stations. The map restyles its layers with
 * these, so a hover or a selection never redraws a source. Each feature carries `lineKey` (line-like
 * features), `lines` (stations, the line keys of the lines serving them) and `name` (stations).
 */

/** A number-valued paint property that may be an expression. */
export type NumberPaint = DataDrivenPropertyValueSpecification<number>

/** A MapLibre expression, before it is typed as a paint value. */
export type PaintExpression = unknown[]

/** What is lit: the selected line, the lines under the pointer, and the station under the pointer. */
export interface Highlight {
  /** The line key of the selected line, or null. */
  selectedKey: string | null
  /** The line keys under the pointer: a line, its badge, or every line serving a hovered station. */
  hoverLines: string[]
  /** The name of the station under the pointer, or null. */
  hoverName: string | null
}

/** Opacity of what is not lit, while anything is lit. */
export const DIMMED_OPACITY = 0.15

function asPaint(expression: PaintExpression): NumberPaint {
  return expression as unknown as NumberPaint
}

/** Whether anything is lit, so that the rest is dimmed. */
export function isActive(highlight: Highlight): boolean {
  return highlight.selectedKey !== null || highlight.hoverLines.length > 0 || highlight.hoverName !== null
}

/** Conditions that light a line-like feature: it belongs to the selected or a hovered line. */
export function litLines(highlight: Highlight): PaintExpression[] {
  const lit: PaintExpression[] = []
  if (highlight.selectedKey !== null) lit.push(['==', ['get', 'lineKey'], highlight.selectedKey])
  if (highlight.hoverLines.length > 0) lit.push(['in', ['get', 'lineKey'], ['literal', highlight.hoverLines]])
  return lit
}

/** Conditions that light a station: it is served by the selected or a hovered line, or it is hovered. */
export function litStations(highlight: Highlight): PaintExpression[] {
  const lit: PaintExpression[] = []
  if (highlight.selectedKey !== null) lit.push(['in', highlight.selectedKey, ['get', 'lines']])
  for (const key of highlight.hoverLines) lit.push(['in', key, ['get', 'lines']])
  if (highlight.hoverName !== null) lit.push(['==', ['get', 'name'], highlight.hoverName])
  return lit
}

/** Full opacity for what is lit, dimmed for the rest while anything is lit. */
export function opacityFor(active: boolean, lit: PaintExpression[]): NumberPaint {
  if (!active) return 1
  return asPaint(['case', ['any', ...lit], 1, DIMMED_OPACITY])
}

/** A value that grows by `bump` on the features matching `matches`, and keeps `base` on the rest. */
export function emphasize(base: NumberPaint, bump: number, matches: PaintExpression | null): NumberPaint {
  if (matches === null) return base
  return asPaint(['case', matches, ['+', base, bump], base])
}

/** Matches the features of the lines under the pointer, or null when none is. */
export function hoveredLineMatch(highlight: Highlight): PaintExpression | null {
  if (highlight.hoverLines.length === 0) return null
  return ['in', ['get', 'lineKey'], ['literal', highlight.hoverLines]]
}

/** Matches the station under the pointer, or null when none is. */
export function hoveredStationMatch(highlight: Highlight): PaintExpression | null {
  if (highlight.hoverName === null) return null
  return ['==', ['get', 'name'], highlight.hoverName]
}
