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
  /** Cancels the whole request, including any retries. */
  signal?: AbortSignal
  /** Per-attempt timeout, in milliseconds. */
  timeoutMs?: number
  /** Waits between attempts. Replaceable in tests. */
  wait?: (ms: number) => Promise<void>
}

/** Overpass query for subway route relations inside the box, with member geometry. */
export function subwayRoutesQuery(box: BoundingBox, timeoutSeconds = 25): string {
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:${timeoutSeconds}][maxsize:16777216];relation["route"="subway"](${bbox});out geom;`
}

// Statuses that usually mean a busy or overloaded server. Other errors come from the query itself.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const ATTEMPTS_PER_ENDPOINT = 2
const RETRY_DELAY_MS = 1000
const TIMEOUT_MS = 30_000
// Rate limiting: honour Retry-After, capped, and fall back to a fixed pause when it is absent.
const RATE_LIMIT_DEFAULT_MS = 5000
const RATE_LIMIT_MAX_MS = 15_000

class OverpassStatusError extends Error {
  readonly status: number
  readonly retryAfterMs: number

  constructor(status: number, retryAfterMs = 0) {
    super(`Overpass responded ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Reads Retry-After (seconds) into milliseconds. Browsers only expose it when the server allows it. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'))
  if (!Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_DEFAULT_MS
  return Math.min(seconds * 1000, RATE_LIMIT_MAX_MS)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fetches subway routes from the first endpoint that answers. Each endpoint gets
 * a short retry when it is busy, then the next endpoint is tried. Errors that a
 * different endpoint would not fix (such as a rejected query) stop at once.
 */
export async function fetchSubwayRoutes(
  endpoints: readonly string[],
  box: BoundingBox,
  options: FetchOptions = {},
): Promise<OverpassResponse> {
  const { fetchFn = fetch, signal, timeoutMs = TIMEOUT_MS, wait = sleep } = options
  const body = new URLSearchParams({ data: subwayRoutesQuery(box) })
  // One entry per failed attempt, so the final error says which server failed and how.
  const failures: string[] = []

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
      try {
        return await requestOnce(fetchFn, endpoint, body, signal, timeoutMs)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof OverpassStatusError && !RETRYABLE_STATUS.has(error.status)) throw error
        failures.push(`${new URL(endpoint).host}: ${error instanceof OverpassStatusError ? error.status : 'network error'}`)
        if (error instanceof OverpassStatusError && error.status === 429) {
          // Pause before any further request, so a rate limit is not answered with a burst to the next server.
          await wait(error.retryAfterMs)
          continue
        }
      }
      if (attempt < ATTEMPTS_PER_ENDPOINT) await wait(RETRY_DELAY_MS * attempt)
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
