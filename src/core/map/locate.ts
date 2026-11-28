// Locate-me: what the map does with a GPS fix, and how a failed request is worded.

/** Zoom used when the map centres on the user. Lines load from this zoom on. */
export const LOCATE_ZOOM = 14

/** Seconds to wait for a fix before giving up. */
export const LOCATE_TIMEOUT_MS = 10_000

/** A short message for a failed geolocation request, from its GeolocationPositionError code. */
export function locateErrorMessage(code: number): string {
  switch (code) {
    case 1:
      return 'Location permission was denied.'
    case 2:
      return 'Your position is unavailable.'
    case 3:
      return 'Timed out while getting your position.'
    default:
      return 'Could not get your position.'
  }
}
