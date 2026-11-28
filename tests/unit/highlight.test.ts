import { describe, expect, it } from 'vitest'
import {
  DIMMED_OPACITY,
  emphasize,
  hoveredLineMatch,
  isActive,
  litLines,
  litStations,
  opacityFor,
  type Highlight,
} from '@/ui/map/highlight'

const none: Highlight = { selectedKey: null, hoverLines: [], hoverName: null }

describe('isActive', () => {
  it('is false with no selection and no hover', () => {
    expect(isActive(none)).toBe(false)
    expect(isActive({ ...none, hoverLines: ['1||'] })).toBe(true)
    expect(isActive({ ...none, selectedKey: '1||' })).toBe(true)
  })
})

describe('opacityFor', () => {
  it('keeps everything opaque while nothing is lit', () => {
    expect(opacityFor(false, litLines(none))).toBe(1)
  })

  it('dims what is not lit while something is lit', () => {
    const highlight = { ...none, hoverLines: ['2||'] }
    expect(opacityFor(isActive(highlight), litLines(highlight))).toEqual([
      'case',
      ['any', ['in', ['get', 'lineKey'], ['literal', ['2||']]]],
      1,
      DIMMED_OPACITY,
    ])
  })
})

describe('litLines', () => {
  it('lights the selected line and every hovered line', () => {
    expect(litLines({ selectedKey: '1||', hoverLines: ['2||', '3||'], hoverName: null })).toHaveLength(2)
    expect(litLines(none)).toEqual([])
  })
})

describe('litStations', () => {
  it('lights stations of the selected or hovered lines, and the hovered station', () => {
    expect(litStations({ selectedKey: '1||', hoverLines: ['2||'], hoverName: 'Botafogo' })).toEqual([
      ['in', '1||', ['get', 'lines']],
      ['in', '2||', ['get', 'lines']],
      ['==', ['get', 'name'], 'Botafogo'],
    ])
  })
})

describe('hoveredLineMatch', () => {
  it('is null when no line is hovered', () => {
    expect(hoveredLineMatch(none)).toBeNull()
  })
})

describe('emphasize', () => {
  it('keeps the base value when nothing matches', () => {
    expect(emphasize(6, 3, null)).toBe(6)
  })

  it('adds the bump on matching features', () => {
    expect(emphasize(6, 3, ['==', ['get', 'lineKey'], '1||'])).toEqual(['case', ['==', ['get', 'lineKey'], '1||'], ['+', 6, 3], 6])
  })
})
