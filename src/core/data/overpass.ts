// Overpass client: subway routes inside a bounding box. Several servers are raced,
// so a slow or failing one does not hold up the map.

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

/** Remembers which server last answered, so the next load tries it first. */
export interface EndpointMemory {
  read(): string | undefined
  write(endpoint: string): void
}

export interface FetchOptions {
  fetchFn?: FetchLike
  /** Cancels the whole request, including every server still being tried. */
  signal?: AbortSignal
  /** Per-server timeout, in milliseconds. */
  timeoutMs?: number
  /** Starts the next server when the current ones have not answered after this long. */
  hedgeMs?: number
  /** Clock, replaceable in tests. */
  now?: () => number
  memory?: EndpointMemory
}

const QUERY_TIMEOUT_S = 10
const TIMEOUT_MS = 10_000
const HEDGE_MS = 2_500
// Statuses that mean a busy or overloaded server. Other statuses come from the query itself.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
// A server that failed is skipped for this long. Retry-After can lengthen it, up to the cap.
const COOLDOWN_MS = 60_000
const COOLDOWN_MAX_MS = 120_000

const MEMORY_KEY = 'overpass:last-ok'
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000

const cooldownUntil = new Map<string, number>()

/** Forgets which servers were skipped. Used by tests. */
export function resetEndpointCooldowns(): void {
  cooldownUntil.clear()
}

/**
 * Overpass query for subway route relations inside the box, with member geometry.
 * A bounding box filter (not around), no "out meta" (the map does not show versions),
 * and "qt" ordering, which Overpass serves faster than ordering by id.
 */
export function subwayRoutesQuery(box: BoundingBox, timeoutSeconds = QUERY_TIMEOUT_S): string {
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:${timeoutSeconds}][maxsize:16777216];relation["route"="subway"](${bbox});out geom qt;`
}

/** Puts the remembered server first, if it is still in the list. Keeps the configured order otherwise. */
export function orderEndpoints(endpoints: readonly string[], remembered: string | undefined): string[] {
  if (!remembered || !endpoints.includes(remembered)) return [...endpoints]
  return [remembered, ...endpoints.filter((endpoint) => endpoint !== remembered)]
}

/**
 * Keeps the last working server in localStorage for a day. Storage can be missing,
 * blocked or full, in which case the memory is simply empty.
 */
export function localEndpointMemory(now: () => number = Date.now): EndpointMemory {
  const storage = (): Storage | undefined => {
    try {
      return globalThis.localStorage
    } catch {
      return undefined
    }
  }
  return {
    read() {
      try {
        const raw = storage()?.getItem(MEMORY_KEY)
        if (!raw) return undefined
        const { endpoint, at } = JSON.parse(raw) as { endpoint: string; at: number }
        return now() - at < MEMORY_TTL_MS ? endpoint : undefined
      } catch {
        return undefined
      }
    },
    write(endpoint) {
      try {
        storage()?.setItem(MEMORY_KEY, JSON.stringify({ endpoint, at: now() }))
      } catch {
        // Not remembering is harmless.
      }
    },
  }
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
 * Fetches subway routes. The first server is asked at once. When it has not answered
 * after hedgeMs, or when it fails, the next server is asked too. The first valid answer
 * wins, and the others are cancelled. Errors another server would not fix (such as a
 * rejected query) stop at once.
 */
export function fetchSubwayRoutes(
  endpoints: readonly string[],
  box: BoundingBox,
  options: FetchOptions = {},
): Promise<OverpassResponse> {
  const {
    fetchFn = fetch,
    signal,
    timeoutMs = TIMEOUT_MS,
    hedgeMs = HEDGE_MS,
    now = Date.now,
    memory = { read: () => undefined, write: () => {} },
  } = options
  const body = new URLSearchParams({ data: subwayRoutesQuery(box) })
  const candidates = orderEndpoints(endpoints, memory.read()).filter(
    (endpoint) => (cooldownUntil.get(endpoint) ?? 0) <= now(),
  )
  // One entry per failed server, so the final error says which server failed and how.
  const failures: string[] = []

  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = []
    let next = 0
    let inFlight = 0
    let done = false
    let hedge: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      done = true
      clearTimeout(hedge)
      signal?.removeEventListener('abort', onCallerAbort)
      for (const controller of controllers) controller.abort()
    }
    const onCallerAbort = () => {
      if (done) return
      finish()
      reject(new DOMException('Request cancelled', 'AbortError'))
    }
    const launch = (): void => {
      if (done || next >= candidates.length) return
      const endpoint = candidates[next++]
      const controller = new AbortController()
      controllers.push(controller)
      inFlight++
      requestOnce(fetchFn, endpoint, body, controller, timeoutMs).then(
        (result) => {
          inFlight--
          if (done) return
          memory.write(endpoint)
          finish()
          resolve(result)
        },
        (error: unknown) => {
          inFlight--
          // Cancelled by us after another server answered, or by the caller.
          if (done) return
          if (error instanceof OverpassStatusError && !RETRYABLE_STATUS.has(error.status)) {
            finish()
            reject(error)
            return
          }
          const retryAfter = error instanceof OverpassStatusError ? error.retryAfterMs : 0
          cooldownUntil.set(endpoint, now() + Math.min(retryAfter || COOLDOWN_MS, COOLDOWN_MAX_MS))
          failures.push(
            `${new URL(endpoint).host}: ${error instanceof OverpassStatusError ? error.status : 'timeout or network error'}`,
          )
          if (inFlight > 0) return
          if (next < candidates.length) {
            launch()
          } else {
            finish()
            reject(new Error(`All Overpass endpoints failed (${failures.join('; ') || 'none available'})`))
          }
        },
      )
      // Hedge: if nothing has answered in time, ask the next server as well.
      clearTimeout(hedge)
      if (next < candidates.length) hedge = setTimeout(launch, hedgeMs)
    }

    if (signal?.aborted) {
      onCallerAbort()
      return
    }
    signal?.addEventListener('abort', onCallerAbort)
    if (candidates.length === 0) {
      done = true
      reject(new Error('All Overpass endpoints failed (none available)'))
      return
    }
    launch()
  })
}

async function requestOnce(
  fetchFn: FetchLike,
  endpoint: string,
  body: URLSearchParams,
  controller: AbortController,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(endpoint, { method: 'POST', body, signal: controller.signal })
    if (!response.ok) {
      throw new OverpassStatusError(response.status, response.status === 429 ? retryAfterMs(response) : 0)
    }
    return (await response.json()) as OverpassResponse
  } finally {
    clearTimeout(timer)
  }
}
