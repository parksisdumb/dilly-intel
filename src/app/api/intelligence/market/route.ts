import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"

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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const county = sp.get("county")?.trim() || parsed.county
  const state = sp.get("state")?.trim().toUpperCase() || null

  // Hide-government toggle. Default ON to match the UI default.
  // The summary RPC ignores this flag (property-level counts are
  // unaffected by owner filtering); only owners + concentration use it.
  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

  const db = createAdminClient()

  const filters = { p_city: city, p_state: state, p_zip: zip, p_county: county }

  // Three RPC calls in parallel: summary counts, concentration, top owners
  // (we slice to top 20 by count + top 20 by sqft client-side).
  const [summaryRes, concRes, ownersRes] = await Promise.all([
    db.rpc("intel_market_summary", filters),
    db.rpc("intel_market_concentration", { ...filters, p_top_n: 10, p_hide_gov: hideGov }),
    db.rpc("intel_owners_concentration", {
      ...filters,
      p_min_properties: 1,
      p_limit: 100,
      p_hide_gov: hideGov,
    }),
  ])

  if (summaryRes.error || concRes.error || ownersRes.error) {
    const msgs = [summaryRes.error, concRes.error, ownersRes.error]
      .filter(Boolean)
      .map((e) => e!.message)
      .join("; ")
    return NextResponse.json({ error: msgs }, { status: 500 })
  }

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

  // Reliability gate: based on RAW null %, not the post-inference one.
  // Inference never moves rows out of the "explicit unknown" bucket — it
  // just buckets the NULLs more usefully — so the raw null rate is the
  // honest measure of how much we're guessing.
  const corporatePctReliable =
    total > 0 ? ownershipRaw.unknown / total <= 0.5 : false

  const matched = {
    matched: summary.find((r) => r.metric === "matched" && r.bucket === "matched")?.cnt ?? 0,
    unmatched: summary.find((r) => r.metric === "matched" && r.bucket === "unmatched")?.cnt ?? 0,
  }

  // Top 20 by property_count (RPC already orders DESC by count) and a
  // client-side re-sort of the same set by total_sqft for the second
  // ranking. The RPC returns up to 100, so the top 20 by sqft is
  // approximate when the by-count list excludes a sqft-heavy owner — the
  // 100-row window covers all realistic top-20-by-sqft cases.
  const topByCount = owners.slice(0, 20)
  const topBySqft = [...owners]
    .filter((o) => o.total_sqft != null && o.total_sqft > 0)
    .sort((a, b) => (b.total_sqft ?? 0) - (a.total_sqft ?? 0))
    .slice(0, 20)

  return NextResponse.json({
    filters: { city, state, zip, county, hide_gov: hideGov },
    summary: {
      total,
      by_type: byType,
      ownership,
      ownership_raw: ownershipRaw,
      corporate_pct: corporatePct,
      corporate_pct_reliable: corporatePctReliable,
      matched,
    },
    concentration: {
      total_market_count: concentration.total_market_count,
      total_owners_count: concentration.total_owners_count,
      top_10_property_count: concentration.top_n_property_count,
      top_10_pct: concentration.top_n_pct ?? 0,
    },
    top_owners_by_count: topByCount,
    top_owners_by_sqft: topBySqft,
  })
}
