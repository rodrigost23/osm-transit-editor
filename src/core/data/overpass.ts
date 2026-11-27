// Overpass client: subway routes inside a bounding box, with endpoint fallback.

export interface BoundingBox {
  south: number
  west: number
  north: number
  east: number
}

export interface OverpassMember {
  type: string
  ref: number
  role: string
  geometry?: { lat: number; lon: number }[]
}

export interface OverpassRelation {
  type: 'relation'
  id: number
  tags?: Record<string, string>
  members?: OverpassMember[]
}

export interface OverpassResponse {
  elements: OverpassRelation[]
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchOptions {
  fetchFn?: FetchLike
  /** Cancels the whole request. */
  signal?: AbortSignal
  /** Per-server timeout, in milliseconds. */
  timeoutMs?: number
  /** Clock, replaceable in tests. */
  now?: () => number
}

/** Overpass query for subway route relations inside the box, with member geometry. */
export function subwayRoutesQuery(box: BoundingBox, timeoutSeconds = QUERY_TIMEOUT_S): string {
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:${timeoutSeconds}][maxsize:16777216];relation["route"="subway"](${bbox});out geom;`
}

// Statuses that mean a busy or overloaded server. Other statuses come from the query itself.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const QUERY_TIMEOUT_S = 15
const TIMEOUT_MS = 15_000
// A server that failed is skipped for this long. Retry-After can lengthen it, up to the cap.
const COOLDOWN_MS = 60_000
const COOLDOWN_MAX_MS = 120_000

const cooldownUntil = new Map<string, number>()

/** Forgets which servers were skipped. Used by tests. */
export function resetEndpointCooldowns(): void {
  cooldownUntil.clear()
}

class OverpassStatusError extends Error {
  readonly status: number
  readonly retryAfterMs: number

  constructor(status: number, retryAfterMs = 0) {
    super(`Overpass responded ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Reads Retry-After (seconds) into milliseconds, or 0 when absent. Browsers only expose it when the server allows it. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/**
 * Fetches subway routes from the first server that answers. A server that is busy,
 * times out or cannot be reached is skipped for a while and the next one is tried at
 * once, without repeating the same server. Errors that another server would not fix
 * (such as a rejected query) stop at once.
 */
export async function fetchSubwayRoutes(
  endpoints: readonly string[],
  box: BoundingBox,
  options: FetchOptions = {},
): Promise<OverpassResponse> {
  const { fetchFn = fetch, signal, timeoutMs = TIMEOUT_MS, now = Date.now } = options
  const body = new URLSearchParams({ data: subwayRoutesQuery(box) })
  // One entry per skipped server, so the final error says which server failed and how.
  const failures: string[] = []

  for (const endpoint of endpoints) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const host = new URL(endpoint).host
    if ((cooldownUntil.get(endpoint) ?? 0) > now()) {
      failures.push(`${host}: skipped, failed recently`)
      continue
    }
    try {
      return await requestOnce(fetchFn, endpoint, body, signal, timeoutMs)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof OverpassStatusError && !RETRYABLE_STATUS.has(error.status)) throw error
      const retryAfter = error instanceof OverpassStatusError ? error.retryAfterMs : 0
      cooldownUntil.set(endpoint, now() + Math.min(retryAfter || COOLDOWN_MS, COOLDOWN_MAX_MS))
      failures.push(`${host}: ${error instanceof OverpassStatusError ? error.status : 'timeout or network error'}`)
    }
  }
  throw new Error(`All Overpass endpoints failed (${failures.join('; ') || 'none configured'})`)
}

async function requestOnce(
  fetchFn: FetchLike,
  endpoint: string,
  body: URLSearchParams,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort)
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetchFn(endpoint, { method: 'POST', body, signal: controller.signal })
    if (!response.ok) {
      throw new OverpassStatusError(response.status, response.status === 429 ? retryAfterMs(response) : 0)
    }
    return (await response.json()) as OverpassResponse
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
