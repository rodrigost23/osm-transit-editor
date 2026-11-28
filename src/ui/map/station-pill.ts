import type * as maplibregl from 'maplibre-gl'

// Image size in pixels, at the pixel ratio below: 14 by 8 CSS pixels.
const WIDTH = 28
const HEIGHT = 16
const PIXEL_RATIO = 2
const BORDER = 4

/** The name of the image for a station served by two lines, one colour each. */
export function pillImageName(colourA: string, colourB: string): string {
  return `station-pill-${colourA}-${colourB}`
}

function pillPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  const radius = height / 2
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.arc(x + width - radius, y + radius, radius, -Math.PI / 2, Math.PI / 2)
  context.lineTo(x + radius, y + height)
  context.arc(x + radius, y + radius, radius, Math.PI / 2, (3 * Math.PI) / 2)
  context.closePath()
}

/**
 * Adds the image of a station shape to the map, once. A white pill with an outline in two halves, one
 * per line. The long side is horizontal, so the icon turns to lie across the track.
 */
export function ensurePillImage(map: maplibregl.Map, colourA: string, colourB: string): string {
  const name = pillImageName(colourA, colourB)
  if (map.hasImage(name)) return name
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (!context) return name
  // The outline: the left half in the first line's colour, the right half in the second's.
  context.save()
  pillPath(context, 0, 0, WIDTH, HEIGHT)
  context.clip()
  context.fillStyle = colourA
  context.fillRect(0, 0, WIDTH / 2, HEIGHT)
  context.fillStyle = colourB
  context.fillRect(WIDTH / 2, 0, WIDTH / 2, HEIGHT)
  context.restore()
  // The white inside, so the outline reads as a border.
  pillPath(context, BORDER, BORDER, WIDTH - 2 * BORDER, HEIGHT - 2 * BORDER)
  context.fillStyle = '#ffffff'
  context.fill()
  map.addImage(name, context.getImageData(0, 0, WIDTH, HEIGHT), { pixelRatio: PIXEL_RATIO })
  return name
}
