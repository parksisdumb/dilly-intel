import type {
  BoundingBox,
  PropTracerMappingResponse,
  PropTracerProperty,
} from './types'

const MAPPING_URL = 'https://api.proptracer.com/v1/property/mapping'
const DETAIL_URL = 'https://api.proptracer.com/v1/property/details'
const RATE_LIMIT_MS = 300
const PAGE_LIMIT = 350
const RATE_429_WAIT_MS = 5_000

export class ProptracerAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProptracerAuthError'
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

function authHeaders(): Record<string, string> {
  const jwt = process.env.PROPTRACER_JWT
  if (!jwt) throw new Error('PROPTRACER_JWT not set in environment')
  return {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  }
}

function bboxPolygon(bbox: BoundingBox): { lat: number; lon: number }[] {
  return [
    { lat: bbox.maxLat, lon: bbox.minLon },
    { lat: bbox.maxLat, lon: bbox.maxLon },
    { lat: bbox.minLat, lon: bbox.maxLon },
    { lat: bbox.minLat, lon: bbox.minLon },
    { lat: bbox.maxLat, lon: bbox.minLon },
  ]
}

export type MappingCallResult = {
  data: { id: string; latitude: number; longitude: number }[]
  resultCount: number
  credits: number
}

/**
 * Make a single mapping API call. Rate-limited 300ms. Handles 401 (auth) and
 * 429 (rate limit, retry once after 5s). Any other error throws.
 */
export async function mappingQuery(
  bbox: BoundingBox,
  buildingSizeMin: number
): Promise<MappingCallResult> {
  const body = {
    size: PAGE_LIMIT,
    and: [{ polygon: bboxPolygon(bbox) }],
    building_size_min: buildingSizeMin,
  }

  const doCall = async (): Promise<Response> => {
    await sleep(RATE_LIMIT_MS)
    return fetch(MAPPING_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
  }

  let res = await doCall()

  if (res.status === 401) {
    throw new ProptracerAuthError(
      'PropTracer JWT expired — update PROPTRACER_JWT in .env.local'
    )
  }

  if (res.status === 429) {
    await sleep(RATE_429_WAIT_MS)
    res = await doCall()
  }

  if (!res.ok) {
    throw new Error(`PropTracer mappingQuery failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as Partial<PropTracerMappingResponse>
  return {
    data: Array.isArray(data.data) ? data.data : [],
    resultCount: typeof data.resultCount === 'number'
      ? data.resultCount
      : (Array.isArray(data.data) ? data.data.length : 0),
    credits: typeof data.credits === 'number' ? data.credits : 0,
  }
}

/**
 * Fetch full property detail. Rate-limited 300ms. Handles 401 and 429 identically
 * to mappingQuery. Returns null on 404 or non-retried failures.
 */
export async function fetchPropertyDetail(id: string): Promise<PropTracerProperty | null> {
  const doCall = async (): Promise<Response> => {
    await sleep(RATE_LIMIT_MS)
    return fetch(`${DETAIL_URL}/${id}`, { headers: authHeaders() })
  }

  let res = await doCall()

  if (res.status === 401) {
    throw new ProptracerAuthError(
      'PropTracer JWT expired — update PROPTRACER_JWT in .env.local'
    )
  }

  if (res.status === 429) {
    await sleep(RATE_429_WAIT_MS)
    res = await doCall()
  }

  if (res.status === 404) return null
  if (!res.ok) return null

  const body = (await res.json()) as Record<string, unknown>
  return normalizeDetail(id, body)
}

function pickStr(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

function pickNum(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k]
    if (v == null || v === '') continue
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (!isNaN(n)) return n
  }
  return null
}

function pickBool(row: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const k of keys) {
    const v = row[k]
    if (v == null) continue
    if (typeof v === 'boolean') return v
    const s = String(v).toLowerCase()
    if (s === 'true' || s === 'yes' || s === '1') return true
    if (s === 'false' || s === 'no' || s === '0') return false
  }
  return null
}

/**
 * Parse the /v1/property/details/{id} response into a flat PropTracerProperty.
 * Structured data lives under data.propertyInfo, data.ownerInfo, data.taxInfo,
 * data.lotInfo. Falls back to flat top-level fields when nested is absent.
 */
function normalizeDetail(id: string, body: Record<string, unknown>): PropTracerProperty {
  const data = (body.data && typeof body.data === 'object')
    ? (body.data as Record<string, unknown>)
    : {}
  const propertyInfo = (data.propertyInfo && typeof data.propertyInfo === 'object')
    ? (data.propertyInfo as Record<string, unknown>)
    : {}
  const ownerInfo = (data.ownerInfo && typeof data.ownerInfo === 'object')
    ? (data.ownerInfo as Record<string, unknown>)
    : {}
  const taxInfo = (data.taxInfo && typeof data.taxInfo === 'object')
    ? (data.taxInfo as Record<string, unknown>)
    : {}
  const lotInfo = (data.lotInfo && typeof data.lotInfo === 'object')
    ? (data.lotInfo as Record<string, unknown>)
    : {}
  const propertyAddress = (propertyInfo.address && typeof propertyInfo.address === 'object')
    ? (propertyInfo.address as Record<string, unknown>)
    : {}
  const mailAddress = (ownerInfo.mailAddress && typeof ownerInfo.mailAddress === 'object')
    ? (ownerInfo.mailAddress as Record<string, unknown>)
    : {}

  // Build street-address-only string (no city/state/zip)
  const streetAddress = pickStr(propertyAddress, 'address')
    ?? pickStr(body, 'address')

  return {
    id,
    latitude: pickNum(propertyInfo, 'latitude') ?? pickNum(body, 'latitude') ?? 0,
    longitude: pickNum(propertyInfo, 'longitude') ?? pickNum(body, 'longitude') ?? 0,
    address: streetAddress,
    city: pickStr(propertyAddress, 'city') ?? pickStr(body, 'city'),
    state: pickStr(propertyAddress, 'state') ?? pickStr(body, 'state'),
    zip: pickStr(propertyAddress, 'zip') ?? pickStr(body, 'zip_code'),
    county: pickStr(propertyAddress, 'county') ?? pickStr(body, 'county'),
    raw_owner_name: pickStr(ownerInfo, 'owner1FullName', 'companyName'),
    owner_mailing_address: pickStr(mailAddress, 'label', 'address'),
    owner_mailing_city: pickStr(mailAddress, 'city'),
    owner_mailing_state: pickStr(mailAddress, 'state'),
    owner_mailing_zip: pickStr(mailAddress, 'zip'),
    apn: pickStr(lotInfo, 'apn', 'apnUnformatted'),
    estimated_value: pickNum(taxInfo, 'marketValue', 'estimatedValue', 'assessedValue')
      ?? pickNum(body, 'estimated_value'),
    year_built: pickNum(propertyInfo, 'yearBuilt'),
    lot_size_sqft: pickNum(propertyInfo, 'lotSquareFeet') ?? pickNum(lotInfo, 'lotSquareFeet'),
    building_sqft: pickNum(propertyInfo, 'buildingSquareFeet', 'livingSquareFeet'),
    property_type: pickStr(propertyInfo, 'propertyUse')
      ?? pickStr(body, 'property_type'),
    property_use_code: pickNum(propertyInfo, 'propertyUseCode'),
    corporate_owned: pickBool(ownerInfo, 'corporateOwned') ?? pickBool(body, 'corporate_owned'),
    absentee_owner: pickBool(ownerInfo, 'absenteeOwner') ?? pickBool(body, 'absentee_owner'),
  }
}

/**
 * Split a bounding box into an n × n grid of equal cells. Used to subdivide
 * dense counties into a FIXED 16-cell grid when resultCount >= PAGE_LIMIT.
 * No recursion — one level, flat.
 */
export function splitBboxIntoGrid(bbox: BoundingBox, n: number): BoundingBox[] {
  const latStep = (bbox.maxLat - bbox.minLat) / n
  const lonStep = (bbox.maxLon - bbox.minLon) / n
  const cells: BoundingBox[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      cells.push({
        minLat: bbox.minLat + i * latStep,
        maxLat: bbox.minLat + (i + 1) * latStep,
        minLon: bbox.minLon + j * lonStep,
        maxLon: bbox.minLon + (j + 1) * lonStep,
      })
    }
  }
  return cells
}

/**
 * Decode a JWT payload without verification. Returns null if malformed.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = padded.length % 4
    const fullyPadded = pad ? padded + '='.repeat(4 - pad) : padded
    const json = Buffer.from(fullyPadded, 'base64').toString('utf-8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

export { PAGE_LIMIT }
