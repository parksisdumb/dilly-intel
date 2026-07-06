import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  applyPropertyFilters,
  hasIndexedScope,
  parseFiltersFromRequest,
} from "@/lib/intel/property-filters"

export const dynamic = "force-dynamic"

const PER_PAGE_DEFAULT = 24
const PER_PAGE_MAX = 96

const SELECT_COLUMNS = [
  "id",
  "street_address",
  "city",
  "state",
  "postal_code",
  "county",
  "latitude",
  "longitude",
  "lat",
  "lng",
  "property_type",
  "property_name",
  "building_sqft",
  "sq_footage",
  "lot_size_sqft",
  "year_built",
  "estimated_value",
  "assessed_value",
  "owner_name",
  "raw_owner_name",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "corporate_owned",
  "absentee_owner",
  "apn",
  "parcel_id",
  "entity_id",
  "proptracer_id",
  "enrichment_status",
  "enrichment_level",
  "source_detail",
  "updated_at",
  "intel_entities!entity_id(id,name,entity_type,ticker,total_properties)",
].join(",")

function clampInt(v: string | null, min: number, max: number, fallback: number): number {
  if (!v) return fallback
  const n = parseInt(v, 10)
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Great-circle distance in miles between two (lat, lon) points.
 * Earth mean radius = 3958.8 miles.
 */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function buildSatelliteUrl(lat: number | null, lng: number | null, key: string | undefined): string | null {
  if (lat == null || lng == null || !key) return null
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=400x220&maptype=satellite&key=${key}`
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const filters = parseFiltersFromRequest(req)

  const page = clampInt(sp.get("page"), 1, 100_000, 1)
  const perPage = clampInt(sp.get("per_page"), 1, PER_PAGE_MAX, PER_PAGE_DEFAULT)

  const db = createAdminClient()
  const from = (page - 1) * perPage
  const to = from + perPage - 1

  // Hybrid count mode. The partial index
  // intel_properties_market_city_state_idx is on (state, lower(city),
  // source_detail), so the planner only stays under the 60s budget when
  // the predicate includes the leading column (state) or another
  // narrow predicate (zip). City-alone searches like ?search=memphis
  // would otherwise run an exact count(*) against all 1.1M rows
  // filtered only by `city ilike '%memphis%'` and time out.
  //
  //   - state OR zip OR zipPrefix present  -> "exact"
  //   - county+state, city+state, etc.    -> "exact" (state covers it)
  //   - city alone, county alone, no filt -> "planned"
  //
  // Aggregate KPIs (total_sqft / total_value / avg_year_built) used to
  // run in parallel here. After the Shelby merge pushed Memphis past
  // 32k rows the combined count + 3 aggregate scans started tripping
  // the 8s authenticator timeout. Aggregates now live at
  // /api/intelligence/properties/stats — the page fetches them in
  // parallel so the cards render immediately and the KPI bar fills in
  // when the (single, combined) aggregate query returns.
  const COUNT_MODE: "exact" | "planned" = hasIndexedScope(filters) ? "exact" : "planned"

  const dataQuery = applyPropertyFilters(
    db.from("intel_properties").select(SELECT_COLUMNS, { count: COUNT_MODE }),
    filters
  )
    .order("building_sqft", { ascending: false, nullsFirst: false })
    .range(from, to)

  // Last-updated query — most recent updated_at across the filtered set.
  const lastUpdatedQuery = applyPropertyFilters(
    db.from("intel_properties").select("updated_at"),
    filters
  )
    .not("updated_at", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const [dataRes, lastUpdatedRes] = await Promise.all([
    dataQuery,
    lastUpdatedQuery,
  ])

  if (dataRes.error) {
    return NextResponse.json({ error: dataRes.error.message }, { status: 500 })
  }

  const total = dataRes.count ?? 0

  const apiKey = process.env.GOOGLE_MAPS_API_KEY

  type RawRow = Record<string, unknown> & {
    intel_entities?: { id: string; name: string; entity_type: string | null; ticker: string | null; total_properties: number | null } | null
  }

  const { centerLat, centerLon, radiusMiles } = filters

  const properties = ((dataRes.data ?? []) as unknown as RawRow[])
    .map((p) => {
      const lat = (p.latitude as number | null) ?? (p.lat as number | null)
      const lng = (p.longitude as number | null) ?? (p.lng as number | null)
      const entity = p.intel_entities ?? null
      const buildingSqft = (p.building_sqft as number | null) ?? (p.sq_footage as number | null)
      // Exact Haversine distance refinement (the bbox pre-filter at the
      // DB layer is conservative; refine to the actual circle here).
      let distanceMiles: number | null = null
      if (radiusMiles != null && centerLat != null && centerLon != null && lat != null && lng != null) {
        distanceMiles = haversineMiles(centerLat, centerLon, lat, lng)
      }
      return {
        id: p.id,
        street_address: p.street_address,
        city: p.city,
        state: p.state,
        postal_code: p.postal_code,
        county: p.county,
        latitude: lat,
        longitude: lng,
        property_type: p.property_type,
        property_name: p.property_name,
        building_sqft: buildingSqft,
        lot_size_sqft: p.lot_size_sqft,
        year_built: p.year_built,
        estimated_value: p.estimated_value ?? p.assessed_value,
        owner_name: p.owner_name ?? p.raw_owner_name,
        raw_owner_name: p.raw_owner_name,
        owner_mailing_address: p.owner_mailing_address,
        owner_mailing_city: p.owner_mailing_city,
        owner_mailing_state: p.owner_mailing_state,
        owner_mailing_zip: p.owner_mailing_zip,
        corporate_owned: p.corporate_owned,
        absentee_owner: p.absentee_owner,
        apn: p.apn ?? p.parcel_id,
        proptracer_id: p.proptracer_id,
        enrichment_status: p.enrichment_status,
        source_detail: p.source_detail,
        entity,
        satellite_url: buildSatelliteUrl(lat, lng, apiKey),
        updated_at: p.updated_at,
        distance_miles: distanceMiles,
      }
    })
    // Drop bbox-pre-filter rows that fall outside the actual circle when
    // radius search is engaged. Without this we'd return corner-of-bbox
    // properties up to ~41% farther than the radius.
    .filter((p) => radiusMiles == null || (p.distance_miles ?? Infinity) <= radiusMiles)

  return NextResponse.json({
    properties,
    page,
    per_page: perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    stats: {
      total,
      // total_sqft / total_value / avg_year_built come from a separate
      // /properties/stats fetch (see route comment above).
      total_sqft: null,
      total_value: null,
      avg_year_built: null,
    },
    last_updated: lastUpdatedRes.data && !lastUpdatedRes.error
      ? (lastUpdatedRes.data as { updated_at: string | null }).updated_at
      : null,
  })
}
