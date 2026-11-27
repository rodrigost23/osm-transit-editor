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

class OverpassStatusError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Overpass responded ${status}`)
    this.status = status
  }
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
  let lastError: unknown = new Error('No Overpass endpoint is configured')

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
      try {
        return await requestOnce(fetchFn, endpoint, body, signal, timeoutMs)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof OverpassStatusError && !RETRYABLE_STATUS.has(error.status)) throw error
        lastError = error
      }
      if (attempt < ATTEMPTS_PER_ENDPOINT) await wait(RETRY_DELAY_MS * attempt)
    }
  }
  throw new Error(`All Overpass endpoints failed. Last error: ${String(lastError)}`)
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
    if (!response.ok) throw new OverpassStatusError(response.status)
    return (await response.json()) as OverpassResponse
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
