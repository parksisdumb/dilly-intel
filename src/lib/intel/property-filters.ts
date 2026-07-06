import type { NextRequest } from "next/server"
import { parseLocationInput } from "@/lib/intel/location-parse"
import {
  ALL_ROLLUP_PATTERNS,
  patternsForCategory,
} from "@/lib/intel/property-types"

// Real-property sources for the /intelligence browser. MUST mirror
// intel_market_sources() exactly so the partial indexes
// (intel_properties_market_city_state_idx etc.) get used by the
// planner — adding a source here without updating the SQL function
// breaks the IN-list match and falls back to a full-table scan.
//
// `cms_provider_data` is intentionally excluded — those are healthcare
// facility records (no sqft, owner = facility operator), useful in
// the market dashboard but noise for the property browser.
export const PROPERTY_SOURCES = [
  "proptracer_mapping",
  "fl_dor_public",
  "nc_onemap_public",
  "tx_cad_dcad",
  "tx_cad_tad",
  "tx_cad_hcad",
  "ms_maris_public",
  "tx_txgio_harris",
  "tx_txgio_bexar",
  "tx_txgio_travis",
  "tx_txgio_public",
  "tn_shelby_regis",
]

const KNOWN_PATTERNS_FLAT: string[] = ALL_ROLLUP_PATTERNS

export type PropertyTypeFilter = {
  ilikePatterns: string[]
  includeOther: boolean
}

export function parsePropertyTypes(raw: string | null): PropertyTypeFilter | null {
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

export function parseNumber(v: string | null): number | null {
  if (!v) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

export type FilterParams = {
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
 * Parse the FilterSidebar query string into the canonical FilterParams
 * shape consumed by applyPropertyFilters. Shared by /properties and
 * /properties/stats so both endpoints filter the same universe; if they
 * drift the KPI totals stop matching the visible cards.
 */
export function parseFiltersFromRequest(req: NextRequest): FilterParams {
  const sp = req.nextUrl.searchParams

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

  const centerLat = parseNumber(sp.get("lat"))
  const centerLon = parseNumber(sp.get("lon"))
  const radiusMilesRaw = parseNumber(sp.get("radius_miles"))
  const radiusMiles =
    centerLat != null && centerLon != null && radiusMilesRaw != null
      ? Math.max(0.1, Math.min(500, radiusMilesRaw))
      : null

  return {
    city, stateAbbr, zip, zipPrefix, county,
    minSqft, maxSqft, ownerType, portfolioMatch,
    minYear, maxYear, minValue, maxValue, types,
    centerLat, centerLon, radiusMiles,
  }
}

/**
 * Apply all filters except pagination/ordering. Used by the data query,
 * count queries, and the aggregate stats endpoint — they all need the
 * same filtered universe so the cards, KPI counts, and sums reconcile.
 *
 * Generic `<T>` so chained filter-builder types are preserved through
 * the call.
 */
export function applyPropertyFilters<T>(qIn: T, params: FilterParams): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = qIn as any
  q = q
    .in("source_detail", PROPERTY_SOURCES)
    .not("street_address", "is", null)
    .not("city", "is", null)
    .not("state", "is", null)

  if (params.stateAbbr) {
    q = q.eq("state", params.stateAbbr)
  }
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
      orParts.push(`property_type.ilike."%${p}%"`)
    }
    if (includeOther) {
      orParts.push("property_type.is.null")
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

/**
 * Same gate as the legacy useExactCount: a state, zip, or zip-prefix
 * filter narrows the universe enough for an exact count or an aggregate
 * to stay inside the statement-timeout budget. Without one, the query
 * would scan the full 1.1M-row table.
 */
export function hasIndexedScope(filters: FilterParams): boolean {
  return !!(filters.stateAbbr || filters.zip || filters.zipPrefix)
}
