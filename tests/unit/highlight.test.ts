import { describe, expect, it } from 'vitest'
import { DIMMED_OPACITY, emphasize, litLines, litStations, opacityFor } from '@/ui/map/highlight'

describe('opacityFor', () => {
  it('keeps everything opaque when no line is selected', () => {
    expect(opacityFor(null, litLines(null, 'a||x'))).toBe(1)
  })

  it('dims everything the selection does not light', () => {
    const expression = opacityFor('1||x', litLines('1||x', null))
    expect(expression).toEqual(['case', ['any', ['==', ['get', 'lineKey'], '1||x']], 1, DIMMED_OPACITY])
  })
})

describe('litLines', () => {
  it('lights the selected and the hovered line, once each', () => {
    expect(litLines('1||x', '2||x')).toHaveLength(2)
    expect(litLines(null, null)).toEqual([])
  })
})

describe('litStations', () => {
  it('lights stations of the selected line and the hovered station', () => {
    expect(litStations('1||x', 'Botafogo')).toEqual([
      ['in', '1||x', ['get', 'lines']],
      ['==', ['get', 'name'], 'Botafogo'],
    ])
  })
})

describe('emphasize', () => {
  it('keeps the base value when nothing matches', () => {
    expect(emphasize(6, 3, null)).toBe(6)
  })

  it('adds the bump on matching features', () => {
    expect(emphasize(6, 3, ['==', ['get', 'lineKey'], '1||x'])).toEqual([
      'case',
      ['==', ['get', 'lineKey'], '1||x'],
      ['+', 6, 3],
      6,
    ])
  })
})
