// Overpass client: subway routes inside a bounding box.

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

/** Overpass query for subway route relations inside the box, with member geometry. */
export function subwayRoutesQuery(box: BoundingBox, timeoutSeconds = 25): string {
  const bbox = [box.south, box.west, box.north, box.east].join(',')
  return `[out:json][timeout:${timeoutSeconds}];relation["route"="subway"](${bbox});out geom;`
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Fetches subway routes. Throws on any non-OK response so the caller can show it. */
export async function fetchSubwayRoutes(
  endpoint: string,
  box: BoundingBox,
  fetchFn: FetchLike = fetch,
): Promise<OverpassResponse> {
  const response = await fetchFn(endpoint, {
    method: 'POST',
    body: new URLSearchParams({ data: subwayRoutesQuery(box) }),
  })
  if (!response.ok) throw new Error(`Overpass responded ${response.status}`)
  return (await response.json()) as OverpassResponse
}
