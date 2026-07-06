import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"
import {
  ROLLUP_CATEGORIES,
  rollupCategory,
  patternsForCategory,
  ALL_ROLLUP_PATTERNS,
} from "@/lib/intel/property-types"

/**
 * Translate a rollup category (e.g. "Retail") into the SQL type-filter
 * RPC arguments. Returns nulls when there's no usable filter so the RPC
 * runs unfiltered.
 *
 *   - A normal category → ILIKE patterns for that category, exclude=false.
 *   - "Other"           → ALL known patterns, exclude=true (match rows
 *                         that hit no rollup category; NULL type counts
 *                         as Other on the SQL side).
 */
function typeFilterArgs(category: string | null): {
  patterns: string[] | null
  exclude: boolean
} {
  if (!category) return { patterns: null, exclude: false }
  if (category === "Other") {
    return {
      patterns: ALL_ROLLUP_PATTERNS.map((p) => `%${p}%`),
      exclude: true,
    }
  }
  const pats = patternsForCategory(category)
  if (pats.length === 0) return { patterns: null, exclude: false }
  return { patterns: pats.map((p) => `%${p}%`), exclude: false }
}

export const dynamic = "force-dynamic"

// /intelligence Market filter buckets — reuse the same labels as the
// PropertyCard property-type pills so the UI is consistent.
const TYPE_BUCKET_ORDER = [
  "office",
  "retail",
  "industrial",
  "multifamily",
  "healthcare",
  "self_storage",
  "mixed_use",
  "hospitality",
  "other_commercial",
  "unknown",
] as const

// Market source allowlist. Mirrors intel_market_sources() from
// supabase/migrations/20260515000001_wire_new_sources_into_market.sql.
// Used only by the small coverage count queries below — the three main
// RPCs scope themselves via intel_market_sources() server-side. If you
// add a source to the SQL function, mirror it here so the coverage
// numbers stay consistent with the RPC-driven totals.
const MARKET_SOURCES = [
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
  // Added 2026-05-23 — Shelby County (Memphis) ReGIS.
  "tn_shelby_regis",
]

// Government-owner patterns. Lives in JS (not SQL) on purpose: when this
// list lived inside intel_is_government_owner(), each ILIKE substring
// match ran per row across 1.1M+ rows in the hot RPCs, busting our
// statement_timeout budget. Filtering after the RPC returns only ~5k
// owner aggregates is millisecond-fast.
const GOV_PATTERNS: string[] = [
  "city of", "county of", "state of",
  "school", "public school",
  "housing authority", "municipal",
  "board of", "department of", "dept of",
  "university", "college", "hospital district",
  "transit", "airport",
  "cdd", "mdha", " isd",
  "water manage", "port authority",
  "revenue finance", "economic dev",
  "development board", "industrial development",
  "commission", "bureau", "agency", "authority",
  "township", "borough", "parish",
  "convention center", "light gas water",
  "public works", "public service",
  "educat", "redevelop", "growth engine",
  "federal", "veterans affairs",
  // Memphis-specific demo patterns added 2026-05-07
  "memphis housing", "shelby county", "development economic",
]

function isGovernmentOwner(name: string | null | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  for (const p of GOV_PATTERNS) {
    if (lower.includes(p)) return true
  }
  return false
}

type SummaryRow = { metric: string; bucket: string | null; cnt: number }
type ConcentrationRow = {
  total_market_count: number
  total_owners_count: number
  top_n_property_count: number
  top_n_pct: number | null
}
type OwnerRow = {
  raw_owner_name: string
  entity_id: string | null
  entity_name: string | null
  entity_ticker: string | null
  property_count: number
  total_sqft: number | null
  total_value: number | null
  avg_sqft: number | null
}

// Words to drop before fuzzy comparison. Corporate suffixes and pure
// noise. We KEEP "Trust", "REIT", "Holdings", "Properties", "Realty",
// "Group" because they're distinguishing for owner names ("Acme Trust"
// vs "Acme Properties" should be different clusters).
const FUZZY_STOPWORDS = new Set([
  "llc", "lp", "llp", "inc", "incorporated", "corp", "corporation",
  "co", "company", "ltd", "limited", "pllc", "pc", "pa",
  "the", "of", "and", "&", "a", "an",
])

const FUZZY_PREFIX_LEN = 5
const FUZZY_THRESHOLD = 0.8

/**
 * Lowercase, drop punctuation, split, drop stopwords, prefix-truncate.
 * Prefix truncation handles stem variants:
 *   "Education"   -> "educa"
 *   "Educational" -> "educa"
 *   "Development" -> "devel"
 *   "Developmental" -> "devel"
 */
function normalizeOwnerWords(name: string): Set<string> {
  if (!name) return new Set()
  const out = new Set<string>()
  for (const raw of name.toLowerCase().replace(/[^\w\s&]/g, " ").split(/\s+/)) {
    const w = raw.trim()
    if (!w || FUZZY_STOPWORDS.has(w)) continue
    out.add(w.slice(0, FUZZY_PREFIX_LEN))
  }
  return out
}

/**
 * Containment of `small` in `large`: how much of the smaller set's
 * vocabulary is covered by the larger set. Returns [0,1]. We use the
 * smaller-of-the-two so that "Development Economic" (2 words) gets
 * absorbed into "Economic Development Growth Engine" (4 words) when
 * its 2 words overlap.
 */
function containmentScore(a: Set<string>, b: Set<string>): number {
  const small = a.size <= b.size ? a : b
  const large = a.size <= b.size ? b : a
  if (small.size === 0) return 0
  let hits = 0
  for (const w of small) if (large.has(w)) hits++
  return hits / small.size
}

type Cluster = {
  display: string
  words: Set<string>
  property_count: number
  total_sqft: number
  total_value: number
  entity_id: string | null
  entity_name: string | null
  entity_ticker: string | null
}

/**
 * Greedy cluster owners by fuzzy word-overlap. Input is assumed sorted
 * by property_count DESC (the RPC returns it that way), so the first
 * row of each cluster keeps its display name — usually the most
 * canonical capitalization. Returns clusters re-sorted by total
 * property_count DESC.
 *
 * Threshold: 0.8 mutual containment. Catches "Education Health" vs
 * "Educational Health", "Development Economic" vs "Economic
 * Development Growth Engine", etc.
 */
function clusterOwners(owners: OwnerRow[]): Cluster[] {
  const clusters: Cluster[] = []
  for (const o of owners) {
    const words = normalizeOwnerWords(o.raw_owner_name)
    if (words.size === 0) continue

    let merged: Cluster | null = null
    for (const c of clusters) {
      if (containmentScore(words, c.words) >= FUZZY_THRESHOLD) {
        merged = c
        break
      }
    }
    if (merged) {
      merged.property_count += Number(o.property_count) || 0
      merged.total_sqft += Number(o.total_sqft) || 0
      merged.total_value += Number(o.total_value) || 0
      // Grow the cluster's vocabulary so subsequent rows can match
      // against any variant we've seen.
      for (const w of words) merged.words.add(w)
      // Inherit entity match if not already set (RPC nulls these out
      // currently — kept here for forward-compat with a richer RPC).
      merged.entity_id ||= o.entity_id
      merged.entity_name ||= o.entity_name
      merged.entity_ticker ||= o.entity_ticker
    } else {
      clusters.push({
        display: o.raw_owner_name,
        words,
        property_count: Number(o.property_count) || 0,
        total_sqft: Number(o.total_sqft) || 0,
        total_value: Number(o.total_value) || 0,
        entity_id: o.entity_id,
        entity_name: o.entity_name,
        entity_ticker: o.entity_ticker,
      })
    }
  }
  clusters.sort((a, b) => b.property_count - a.property_count)
  return clusters
}

function clusterToOwnerRow(c: Cluster): OwnerRow {
  return {
    raw_owner_name: c.display,
    entity_id: c.entity_id,
    entity_name: c.entity_name,
    entity_ticker: c.entity_ticker,
    property_count: c.property_count,
    total_sqft: c.total_sqft || null,
    total_value: c.total_value || null,
    avg_sqft: c.total_sqft && c.property_count
      ? c.total_sqft / c.property_count
      : null,
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const county = sp.get("county")?.trim() || parsed.county
  const state = sp.get("state")?.trim().toUpperCase() || null

  // Safety net for the frontend state gate. An unfiltered market query
  // scans the full ~1.1M-row table and trips the statement timeout, so
  // we never let one reach the database — bail out before any RPC call.
  if (!state) {
    return NextResponse.json(
      { error: "State parameter required" },
      { status: 400 }
    )
  }

  // Hide-government toggle. Default ON to match the UI default.
  // The summary RPC ignores this flag (property-level counts are
  // unaffected by owner filtering); only owners + concentration use it.
  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

  // Optional property-type filter. Accepts a rollup category label
  // ("Retail", "Industrial", "Other", …). Anything not in the known
  // taxonomy is ignored (treated as no filter).
  const propertyTypeRaw = sp.get("property_type")?.trim() || null
  const propertyType =
    propertyTypeRaw &&
    (ROLLUP_CATEGORIES as readonly string[]).includes(propertyTypeRaw)
      ? propertyTypeRaw
      : null
  const { patterns: typePatterns, exclude: typeExclude } =
    typeFilterArgs(propertyType)
  const typeArgs = {
    p_type_patterns: typePatterns,
    p_type_exclude: typeExclude,
  }

  const db = createAdminClient()

  const filters = { p_city: city, p_state: state, p_zip: zip, p_county: county }

  // Coverage-stat builder. Same filter shape as the RPCs use server-side
  // (state + market source allowlist + optional city/zip/county). count:
  // 'exact' with head: true is a PG count(*) against an indexed predicate,
  // so it's ms-fast for the 10k-row scale of a single market. The two
  // builders below share this base.
  const buildCountQuery = () => {
    let q = db
      .from("intel_properties")
      .select("id", { count: "exact", head: true })
      .eq("state", state)
      .in("source_detail", MARKET_SOURCES)
    if (city) q = q.ilike("city", `${city}%`)
    if (zip) q = q.eq("postal_code", zip)
    if (county) q = q.ilike("county", `%${county}%`)
    // Property-type filter for the coverage counts. The include case
    // (a normal rollup category) is a clean OR of ILIKE patterns. The
    // "Other" case is a negation that PostgREST can't express cleanly
    // alongside a NULL-OR — these two counts are supplementary coverage
    // indicators, so for "Other" we leave them market-wide rather than
    // approximate.
    if (typePatterns && !typeExclude) {
      q = q.or(
        patternsForCategory(propertyType as string)
          .map((p) => `property_type.ilike."%${p}%"`)
          .join(","),
      )
    }
    return q
  }

  // Three RPC calls + two coverage counts in parallel. Government
  // filtering happens in JS post-hoc (see GOV_PATTERNS at the top of
  // this file). p_limit bumped to 5000 so the long tail is available
  // to the JS concentration recompute (top-N over a filtered set).
  //
  // Mailing-address portfolios used to be a 4th call here but its
  // GROUP BY on owner_mailing_address was the slowest of the bunch
  // and could push the whole response over Next.js's connection budget.
  // It now lives at /api/intelligence/market/portfolios — the page
  // fetches it separately so the headline KPIs and owner tables
  // render independently.
  //
  // The coverage queries are intentionally NOT inside the existing
  // intel_market_summary RPC. They use the same indexed predicate as
  // the RPC's CTE but PostgREST count(*) is server-side and cheap, and
  // we don't want to risk regressing the just-stabilized RPC.
  // intel_market_summary and intel_owners_concentration take the type
  // filter. intel_market_concentration deliberately does NOT — when a
  // type filter is active the concentration line is derived below from
  // the (type-filtered) summary total + owners list instead.
  const [summaryRes, concRes, ownersRes, ownerNameRes, mailingAddrRes] =
    await Promise.all([
      db.rpc("intel_market_summary", { ...filters, ...typeArgs }),
      db.rpc("intel_market_concentration", { ...filters, p_top_n: 10 }),
      db.rpc("intel_owners_concentration", {
        ...filters,
        p_min_properties: 1,
        p_limit: 5000,
        ...typeArgs,
      }),
      buildCountQuery().not("owner_name", "is", null),
      buildCountQuery()
        .not("owner_mailing_address", "is", null)
        .not("owner_mailing_address", "eq", ""),
    ])

  if (summaryRes.error || concRes.error || ownersRes.error) {
    const msgs = [summaryRes.error, concRes.error, ownersRes.error]
      .filter(Boolean)
      .map((e) => e!.message)
      .join("; ")
    return NextResponse.json({ error: msgs }, { status: 500 })
  }

  // Coverage counts: log and continue if they fail. The dashboard
  // degrades gracefully — the new stats just render "—" instead of a
  // percentage — rather than blowing up the whole response.
  const ownerNameCount = ownerNameRes.count ?? null
  const mailingAddressCount = mailingAddrRes.count ?? null

  const summary = (summaryRes.data ?? []) as SummaryRow[]
  const concentration = ((concRes.data ?? []) as ConcentrationRow[])[0] ?? {
    total_market_count: 0,
    total_owners_count: 0,
    top_n_property_count: 0,
    top_n_pct: 0,
  }
  const owners = (ownersRes.data ?? []) as OwnerRow[]

  // Pivot summary into a structured shape
  const total = summary.find((r) => r.metric === "total")?.cnt ?? 0
  // Market-sizing aggregates from the extended intel_market_summary RPC
  // (migration 20260519000001). All three return 0 when the extended
  // migration hasn't been applied — handled as null below so the UI
  // shows "—" instead of "0".
  const totalSqftRaw = summary.find((r) => r.metric === "total_sqft")?.cnt
  const totalValueRaw = summary.find((r) => r.metric === "total_value")?.cnt
  const avgYearRaw = summary.find((r) => r.metric === "avg_year_built")?.cnt
  const totalSqft =
    totalSqftRaw != null && totalSqftRaw > 0 ? Number(totalSqftRaw) : null
  const totalValue =
    totalValueRaw != null && totalValueRaw > 0 ? Number(totalValueRaw) : null
  const avgYearBuilt =
    avgYearRaw != null && avgYearRaw >= 1800 && avgYearRaw <= 2100
      ? Number(avgYearRaw)
      : null

  const byTypeRaw = summary
    .filter((r) => r.metric === "by_type")
    .map((r) => ({ bucket: r.bucket || "unknown", count: Number(r.cnt) }))
  // Sort by canonical order, then alphabetically for any extras
  const byType = byTypeRaw.sort((a, b) => {
    const ai = TYPE_BUCKET_ORDER.indexOf(a.bucket as (typeof TYPE_BUCKET_ORDER)[number])
    const bi = TYPE_BUCKET_ORDER.indexOf(b.bucket as (typeof TYPE_BUCKET_ORDER)[number])
    const aIdx = ai === -1 ? 999 : ai
    const bIdx = bi === -1 ? 999 : bi
    if (aIdx !== bIdx) return aIdx - bIdx
    return a.bucket.localeCompare(b.bucket)
  })

  // Roll the granular PropTracer types up into the standard contractor-
  // facing categories (Office / Retail / Industrial / etc). The market
  // dashboard renders this view by default, with a toggle to drop back
  // to byType for analysts who want the full PropTracer-level detail.
  const rollupCounts: Record<string, number> = {}
  for (const cat of ROLLUP_CATEGORIES) rollupCounts[cat] = 0
  for (const t of byType) {
    const cat = rollupCategory(t.bucket)
    rollupCounts[cat] = (rollupCounts[cat] ?? 0) + t.count
  }
  const byTypeRollup = ROLLUP_CATEGORIES
    .map((cat) => ({ bucket: cat, count: rollupCounts[cat] ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)

  // Post-inference ownership counts (corporate suffix / individual heuristic
  // applied at the DB level inside intel_market_summary).
  const ownership = {
    corporate: summary.find((r) => r.metric === "ownership" && r.bucket === "corporate")?.cnt ?? 0,
    individual: summary.find((r) => r.metric === "ownership" && r.bucket === "individual")?.cnt ?? 0,
    unknown: summary.find((r) => r.metric === "ownership" && r.bucket === "unknown")?.cnt ?? 0,
  }
  // Raw counts (no inference applied) — used to gate display reliability.
  // If >50% of records have NO explicit corporate_owned value (FL DOR is
  // the main offender), the corporate% is unreliable and the UI should
  // render "N/A".
  const ownershipRaw = {
    corporate: summary.find((r) => r.metric === "ownership_raw" && r.bucket === "corporate")?.cnt ?? 0,
    individual: summary.find((r) => r.metric === "ownership_raw" && r.bucket === "individual")?.cnt ?? 0,
    unknown: summary.find((r) => r.metric === "ownership_raw" && r.bucket === "unknown")?.cnt ?? 0,
  }
  const ownershipKnown = ownership.corporate + ownership.individual
  const corporatePct =
    ownershipKnown > 0 ? Math.round((ownership.corporate / ownershipKnown) * 100) : 0

  // Reliability gate: based on RAW (non-inferred) coverage. The audit
  // tightened this from 50% → 10% — show the stat unless fewer than 10%
  // of records have an explicit corporate_owned value.
  const ownershipRawKnown = ownershipRaw.corporate + ownershipRaw.individual
  const corporatePctReliable =
    total > 0 ? ownershipRawKnown / total >= 0.1 : false

  // Estimated when any of the corporate/individual buckets came from
  // inference. The RPC's ownership counts include inferred buckets;
  // ownership_raw counts only explicit values. If they differ, the
  // displayed percentage was partly inferred — flag it as "est.".
  const corporatePctEstimated =
    corporatePctReliable &&
    (ownership.corporate !== ownershipRaw.corporate ||
      ownership.individual !== ownershipRaw.individual)

  const matched = {
    matched: summary.find((r) => r.metric === "matched" && r.bucket === "matched")?.cnt ?? 0,
    unmatched: summary.find((r) => r.metric === "matched" && r.bucket === "unmatched")?.cnt ?? 0,
  }

  // Pipeline: optional gov filter -> fuzzy cluster -> top-N slice.
  //
  //  1. hide_gov filter: applied here in JS, not in SQL. See
  //     GOV_PATTERNS at top of file for why.
  //  2. Cluster: collapses word-stem variants ("Education Health" vs
  //     "Educational Health") and reorderings ("Development Economic"
  //     vs "Economic Development Growth Engine") that the RPC's
  //     UPPER(TRIM(REGEXP_REPLACE)) dedup misses.
  //  3. Slice top 20 by property_count and by total_sqft.
  const filteredOwners = hideGov
    ? owners.filter((o) => !isGovernmentOwner(o.raw_owner_name))
    : owners
  const clusters = clusterOwners(filteredOwners)
  const topByCount = clusters.slice(0, 20).map(clusterToOwnerRow)
  const topBySqft = [...clusters]
    .filter((c) => c.total_sqft > 0)
    .sort((a, b) => b.total_sqft - a.total_sqft)
    .slice(0, 20)
    .map(clusterToOwnerRow)

  return NextResponse.json({
    filters: {
      city,
      state,
      zip,
      county,
      hide_gov: hideGov,
      property_type: propertyType,
    },
    summary: {
      total,
      by_type: byType,
      by_type_rollup: byTypeRollup,
      ownership,
      ownership_raw: ownershipRaw,
      corporate_pct: corporatePct,
      corporate_pct_reliable: corporatePctReliable,
      corporate_pct_estimated: corporatePctEstimated,
      matched,
      // Data-coverage counts for the reframed ownership panel. Null if
      // the count query failed — UI falls back to "—".
      owner_name_count: ownerNameCount,
      mailing_address_count: mailingAddressCount,
      // Market-sizing KPIs for the top strip. Null when the source rows
      // don't carry a value (TX TxGIO / MS MARIS have minimal sqft
      // coverage, so the headline may be N/A).
      total_sqft: totalSqft,
      total_value: totalValue,
      avg_year_built: avgYearBuilt,
    },
    // Concentration line.
    //
    // Unfiltered: uses intel_market_concentration's market-wide totals
    // as the denominator so every number reconciles with the KPI bar.
    //
    // Type-filtered: intel_market_concentration was NOT given the type
    // filter, so its totals are market-wide and wrong for this view.
    // Instead derive everything from the type-filtered data already in
    // hand — total = summary.total (type-filtered), owners = clustered
    // type-filtered owners list. top-10 is the cluster-sum either way.
    concentration: (() => {
      const typeFiltered = propertyType != null
      const totalMarket = typeFiltered
        ? total
        : concentration.total_market_count
      const totalOwners = typeFiltered
        ? clusters.length
        : concentration.total_owners_count
      const top10Property =
        hideGov || typeFiltered
          ? clusters.slice(0, 10).reduce((s, c) => s + c.property_count, 0)
          : concentration.top_n_property_count
      const top10Pct = totalMarket > 0
        ? Math.round((10000 * top10Property) / totalMarket) / 100
        : 0
      return {
        total_market_count: totalMarket,
        total_owners_count: totalOwners,
        top_10_property_count: top10Property,
        top_10_pct: top10Pct,
      }
    })(),
    top_owners_by_count: topByCount,
    top_owners_by_sqft: topBySqft,
    // Portfolio owners moved to /api/intelligence/market/portfolios.
    // The market page fetches it asynchronously so this response can
    // return without waiting on the heaviest GROUP BY of the dashboard.
  })
}
