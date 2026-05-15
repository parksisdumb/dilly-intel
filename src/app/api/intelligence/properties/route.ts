import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"
import {
  ALL_ROLLUP_PATTERNS,
  patternsForCategory,
} from "@/lib/intel/property-types"

export const dynamic = "force-dynamic"

// Real-property sources for the /intelligence browser. MUST mirror
// intel_market_sources() exactly so the partial indexes
// (intel_properties_market_city_state_idx etc.) get used by the
// planner — adding a source here without updating the SQL function
// breaks the IN-list match and falls back to a full-table scan.
//
// `cms_provider_data` is intentionally excluded — those are healthcare
// facility records (no sqft, owner = facility operator), useful in
// the market dashboard but noise for the property browser.
const PROPERTY_SOURCES = [
  "proptracer_mapping",
  "fl_dor_public",
  "nc_onemap_public",
  "tx_cad_dcad",
  "tx_cad_tad",
  "tx_cad_hcad",
  // Added 2026-05-15 — MS MARIS + TX TxGIO ingests (~160k rows). Must
  // stay in sync with intel_market_sources() and the market partial-
  // index predicates (migration 20260515000001) — a query whose source
  // set is wider than an index's predicate cannot use that index.
  "ms_maris_public",
  "tx_txgio_harris",
  "tx_txgio_bexar",
  "tx_txgio_travis",
  "tx_txgio_public",
]

const PER_PAGE_DEFAULT = 24
const PER_PAGE_MAX = 96

// User-facing filter checkbox labels are rollup categories from
// src/lib/intel/property-types.ts. Each category's ILIKE substring
// patterns come from the same source so the filter behavior matches
// the market dashboard's by_type_rollup grouping exactly.
//
// `Other` is handled separately as the "matches none of the known
// rollup patterns" bucket.
const KNOWN_PATTERNS_FLAT: string[] = ALL_ROLLUP_PATTERNS

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

type PropertyTypeFilter = {
  ilikePatterns: string[]
  includeOther: boolean
}

function parsePropertyTypes(raw: string | null): PropertyTypeFilter | null {
  if (!raw) return null
  const types = raw.split(",").map((s) => s.trim()).filter(Boolean)
  if (types.length === 0) return null

  const ilikePatterns: string[] = []
  let includeOther = false
  for (const t of types) {
    if (t === "Other") {
      includeOther = true
      continue
    }
    const pats = patternsForCategory(t)
    if (pats.length > 0) ilikePatterns.push(...pats)
  }
  return { ilikePatterns, includeOther }
}

function clampInt(v: string | null, min: number, max: number, fallback: number): number {
  if (!v) return fallback
  const n = parseInt(v, 10)
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function parseNumber(v: string | null): number | null {
  if (!v) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
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

type FilterParams = {
  city: string | null
  stateAbbr: string | null
  zip: string | null
  zipPrefix: string | null
  county: string | null
  minSqft: number | null
  maxSqft: number | null
  ownerType: string
  portfolioMatch: string
  minYear: number | null
  maxYear: number | null
  minValue: number | null
  maxValue: number | null
  types: PropertyTypeFilter | null
  // Radius search (when all three present, bounding-box pre-filter is
  // applied at the DB layer; exact Haversine refinement happens client-
  // side on the returned page).
  centerLat: number | null
  centerLon: number | null
  radiusMiles: number | null
}


/**
 * Apply all filters except pagination/ordering. Used by the data query and by
 * the parallel count queries that compute the top-bar stats — they need the
 * same filtered universe.
 *
 * Generic `<T>` so chained filter-builder types are preserved through the call.
 */
function applyFilters<T>(qIn: T, params: FilterParams): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = qIn as any
  // Show all real-property sources, not just PropTracer. Excludes
  // EDGAR entity rows (corporations) and any future tags that aren't
  // commercial-property records. Mirrors intel_market_sources() on
  // the market dashboard so /intelligence and /intelligence/market
  // see the same universe.
  q = q
    .in("source_detail", PROPERTY_SOURCES)
    .not("street_address", "is", null)
    .not("city", "is", null)
    .not("state", "is", null)

  if (params.stateAbbr) {
    // Already uppercased at the entrypoint — eq() so Postgres uses the index.
    q = q.eq("state", params.stateAbbr)
  }
  // Location filters — zip wins over zipPrefix wins over city.
  // (zip + city can both be set when input was "37138 Memphis".)
  if (params.zip) {
    q = q.eq("postal_code", params.zip)
  } else if (params.zipPrefix) {
    q = q.like("postal_code", `${params.zipPrefix}%`)
  }
  if (params.city) {
    q = q.ilike("city", `%${params.city}%`)
  }
  if (params.county) {
    q = q.ilike("county", `%${params.county}%`)
  }
  // Radius search: bounding-box pre-filter using simple lat/lon range
  // comparisons (hits the existing latitude/longitude btree indexes).
  // The page's response payload also gets distance computed client-side
  // for an exact Haversine refinement (see RADIUS_REFINE below).
  if (params.centerLat != null && params.centerLon != null && params.radiusMiles) {
    const dLat = params.radiusMiles / 69.0
    const dLon =
      params.radiusMiles /
      (69.0 * Math.cos((params.centerLat * Math.PI) / 180.0) || 1e-6)
    q = q
      .gte("latitude", params.centerLat - dLat)
      .lte("latitude", params.centerLat + dLat)
      .gte("longitude", params.centerLon - dLon)
      .lte("longitude", params.centerLon + dLon)
  }
  if (params.minSqft != null) {
    q = q.gte("building_sqft", params.minSqft)
  }
  if (params.maxSqft != null) {
    q = q.lte("building_sqft", params.maxSqft)
  }
  if (params.ownerType === "corporate") {
    q = q.eq("corporate_owned", true)
  } else if (params.ownerType === "individual") {
    q = q.or("corporate_owned.eq.false,corporate_owned.is.null")
  }
  if (params.portfolioMatch === "matched") {
    q = q.not("entity_id", "is", null)
  }
  if (params.minYear != null) {
    q = q.gte("year_built", params.minYear)
  }
  if (params.maxYear != null) {
    q = q.lte("year_built", params.maxYear)
  }
  // Estimated value range. The schema stores this in `estimated_value`
  // (numeric); we accept dollars from the UI and pass through as-is.
  if (params.minValue != null) {
    q = q.gte("estimated_value", params.minValue)
  }
  if (params.maxValue != null) {
    q = q.lte("estimated_value", params.maxValue)
  }
  if (params.types) {
    const { ilikePatterns, includeOther } = params.types
    const orParts: string[] = []
    for (const p of ilikePatterns) {
      // Wrap value in double-quotes so embedded commas / colons / parens
      // (e.g. "bar, tavern", "neighborhood: shopping", "homes (retired")
      // don't get parsed as PostgREST logic-tree separators.
      orParts.push(`property_type.ilike."%${p}%"`)
    }
    if (includeOther) {
      // "Other" = property_type is NULL, OR matches none of the known buckets.
      // PostgREST .or() can't easily express AND-of-NOTs, so use a separate
      // `not.ilike.all()` filter via .not() chain — simpler: include
      // null-check; rely on UI rarely combining Other with all 7 others.
      orParts.push("property_type.is.null")
      // For each known pattern, exclude — but only when *only* Other is picked.
      // If user picks Other alongside e.g. Office, the OR already covers it.
      if (ilikePatterns.length === 0) {
        for (const p of KNOWN_PATTERNS_FLAT) {
          q = q.not("property_type", "ilike", `%${p}%`)
        }
      }
    }
    if (orParts.length > 0) {
      q = q.or(orParts.join(","))
    }
  }
  return q as T
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  // Single search input (FilterSidebar) is parsed into city/zip/zipPrefix/
  // county. Explicit ?city=, ?zip=, ?county= params override the parsed
  // form so a programmatic call can disambiguate.
  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const zipPrefix = sp.get("zip_prefix")?.trim() || parsed.zipPrefix
  const county = sp.get("county")?.trim() || parsed.county

  const stateAbbr = sp.get("state")?.trim().toUpperCase() || null
  const minSqft = parseNumber(sp.get("min_sqft"))
  const maxSqft = parseNumber(sp.get("max_sqft"))
  const ownerType = (sp.get("owner_type") || "all").toLowerCase()
  const portfolioMatch = (sp.get("portfolio_match") || "all").toLowerCase()
  const minYear = parseNumber(sp.get("min_year"))
  const maxYear = parseNumber(sp.get("max_year"))
  const minValue = parseNumber(sp.get("min_value"))
  const maxValue = parseNumber(sp.get("max_value"))
  const types = parsePropertyTypes(sp.get("property_types"))

  // Radius search params — all three required to engage. Validated as
  // numeric and clamped to a sane range.
  const centerLat = parseNumber(sp.get("lat"))
  const centerLon = parseNumber(sp.get("lon"))
  const radiusMilesRaw = parseNumber(sp.get("radius_miles"))
  const radiusMiles =
    centerLat != null && centerLon != null && radiusMilesRaw != null
      ? Math.max(0.1, Math.min(500, radiusMilesRaw))
      : null

  const page = clampInt(sp.get("page"), 1, 100_000, 1)
  const perPage = clampInt(sp.get("per_page"), 1, PER_PAGE_MAX, PER_PAGE_DEFAULT)

  const filters: FilterParams = {
    city, stateAbbr, zip, zipPrefix, county,
    minSqft, maxSqft, ownerType, portfolioMatch,
    minYear, maxYear, minValue, maxValue, types,
    centerLat, centerLon, radiusMiles,
  }

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
  //     (state caps the universe at ~100k; zip is tighter still.)
  //   - county+state, city+state, etc.    -> "exact" (state covers it)
  //   - city alone, county alone, no filt -> "planned"
  //     (planned reads pg_class.reltuples after EXPLAIN selectivity
  //     estimates — accurate within ~10% if ANALYZE is current.)
  //
  // Stat queries (corporate / matched) reuse COUNT_MODE so they share
  // the trade-off.
  //
  // Operational dependency: the planner estimates are only as good as
  // pg_class statistics. Schedule `ANALYZE intel_properties` after each
  // bulk ingest run, or set up a nightly `VACUUM (ANALYZE)` cron — without
  // it, the planned counts will drift downward over time as the table
  // grows past the last sampled snapshot.
  const useExactCount = !!(
    filters.stateAbbr || filters.zip || filters.zipPrefix
  )
  const COUNT_MODE: "exact" | "planned" = useExactCount ? "exact" : "planned"

  // Main data query — fetched with the entity left-joined.
  const dataQuery = applyFilters(
    db.from("intel_properties").select(SELECT_COLUMNS, { count: COUNT_MODE }),
    filters
  )
    .order("building_sqft", { ascending: false, nullsFirst: false })
    .range(from, to)

  // Parallel stat queries — same filters, just count-only.
  // Corporate count uses inference: explicit TRUE OR (NULL + name has a
  // corporate-suffix). FL DOR rows are predominantly corporate_owned IS
  // NULL, so the explicit-only count was returning 0% for Tampa. The
  // PostgREST `or=` syntax matches the SQL `intel_infer_corporate()`
  // helper added in 20260430000001.
  const CORP_SUFFIX_REGEX =
    "(?i)(LLC|L\\.L\\.C|LP|L\\.P|LLP|INC|INCORPORATED|CORP|CORPORATION|" +
    "LTD|LIMITED|TRUST|REIT|HOLDINGS|PROPERTIES|PROPERTY|REALTY|" +
    "PARTNERSHIP|GROUP|COMPANY|ASSOCIATION|BANK|BANCORP)"

  const corporateCountQuery = applyFilters(
    db.from("intel_properties").select("id", { count: COUNT_MODE, head: true }),
    filters
  ).or(
    `corporate_owned.eq.true,and(corporate_owned.is.null,raw_owner_name.imatch.${CORP_SUFFIX_REGEX})`
  )

  // Raw-null count — used to compute corporate_pct_reliable (we
  // shouldn't trust the percentage when >50% have no explicit value).
  const corporateRawNullQuery = applyFilters(
    db.from("intel_properties").select("id", { count: COUNT_MODE, head: true }),
    filters
  ).is("corporate_owned", null)

  const matchedCountQuery = applyFilters(
    db.from("intel_properties").select("id", { count: COUNT_MODE, head: true }),
    filters
  ).not("entity_id", "is", null)

  // Sample up to 1,000 sqft values for an avg estimate. No ORDER BY — we want
  // disk-order sampling. Sorting 289k rows for a top-bar stat blows the
  // statement-timeout budget on an unindexed column.
  const sqftSampleQuery = applyFilters(
    db.from("intel_properties").select("building_sqft"),
    filters
  )
    .not("building_sqft", "is", null)
    .limit(1000)

  // Last-updated query — most recent updated_at across the filtered set.
  const lastUpdatedQuery = applyFilters(
    db.from("intel_properties").select("updated_at"),
    filters
  )
    .not("updated_at", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const [dataRes, corpRes, corpNullRes, matchedRes, sqftSampleRes, lastUpdatedRes] = await Promise.all([
    dataQuery,
    corporateCountQuery,
    corporateRawNullQuery,
    matchedCountQuery,
    sqftSampleQuery,
    lastUpdatedQuery,
  ])

  if (dataRes.error) {
    return NextResponse.json({ error: dataRes.error.message }, { status: 500 })
  }

  const total = dataRes.count ?? 0
  const corporateCount = corpRes.count ?? 0
  const corporateRawNullCount = corpNullRes.count ?? 0
  const matchedCount = matchedRes.count ?? 0

  const sqftSample = (sqftSampleRes.data ?? []) as { building_sqft: number | null }[]
  const sqftValues = sqftSample.map((r) => r.building_sqft).filter((v): v is number => typeof v === "number" && v > 0)
  const avgSqft = sqftValues.length > 0
    ? Math.round(sqftValues.reduce((a, b) => a + b, 0) / sqftValues.length)
    : 0

  const corporatePct = total > 0 ? Math.round((corporateCount / total) * 100) : 0
  // Don't trust the percentage when >50% of rows have no explicit
  // corporate_owned value. (Inference fills some, but raw-null is the
  // honest signal of how much we're guessing.)
  const corporatePctReliable =
    total > 0 ? corporateRawNullCount / total <= 0.5 : false

  const apiKey = process.env.GOOGLE_MAPS_API_KEY

  type RawRow = Record<string, unknown> & {
    intel_entities?: { id: string; name: string; entity_type: string | null; ticker: string | null; total_properties: number | null } | null
  }

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
      corporate_count: corporateCount,
      corporate_pct: corporatePct,
      corporate_pct_reliable: corporatePctReliable,
      matched_count: matchedCount,
      avg_sqft: avgSqft,
    },
    last_updated: lastUpdatedRes.data && !lastUpdatedRes.error
      ? (lastUpdatedRes.data as { updated_at: string | null }).updated_at
      : null,
  })
}
