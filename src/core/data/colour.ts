// Validates an OSM colour tag. Only hex colours are accepted; anything else
// (named or malformed values) falls back to a neutral grey and is flagged.
export const neutralColour = '#8a8a8a'

const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function resolveColour(value: string | undefined): { colour: string; valid: boolean } {
  if (value !== undefined && hex.test(value)) return { colour: value, valid: true }
  return { colour: neutralColour, valid: false }
}
