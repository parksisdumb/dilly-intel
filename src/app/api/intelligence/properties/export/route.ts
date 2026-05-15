import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"
import { patternsForCategory } from "@/lib/intel/property-types"

export const dynamic = "force-dynamic"

// Hard cap on a single export. CSV is meant for "take this list to my CRM"
// not "dump the whole national database" — keep it reasonable.
const EXPORT_CAP = 10_000

// Source list for CSV export. Keep in sync with the main /properties
// route when its universe changes.
//
// NOTE: this list is intentionally NOT identical to the main route's
// PROPERTY_SOURCES — it additionally carries cook_county_il_public /
// oh_* / ga_fulton_public, which predate the market-index work and are
// not in intel_market_sources() or the partial-index predicates. Export
// therefore does not get index coverage for those extra sources (it is
// capped at 10k rows, so the seq-scan cost is bounded). Reconciling this
// divergence is tracked separately.
const PROPERTY_SOURCES = [
  "proptracer_mapping",
  "fl_dor_public",
  "nc_onemap_public",
  "tx_cad_dcad",
  "tx_cad_tad",
  "tx_cad_hcad",
  // Added 2026-05-15 — MS MARIS + TX TxGIO ingests.
  "ms_maris_public",
  "tx_txgio_harris",
  "tx_txgio_bexar",
  "tx_txgio_travis",
  "tx_txgio_public",
  "cook_county_il_public",
  "oh_cuyahoga_public",
  "oh_franklin_public",
  "ga_fulton_public",
]

const SELECT_COLUMNS = [
  "street_address", "city", "state", "postal_code",
  "owner_name", "raw_owner_name",
  "building_sqft", "year_built",
  "estimated_value", "property_type",
].join(",")

const CSV_HEADER = [
  "street_address",
  "city",
  "state",
  "zip",
  "owner_name",
  "building_sqft",
  "year_built",
  "estimated_value",
  "property_type",
].join(",")

function csvEscape(v: unknown): string {
  if (v == null) return ""
  const s = String(v)
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function parseNumber(v: string | null): number | null {
  if (!v) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function buildIlikeOr(category: string): string[] {
  if (category === "Other") return []
  return patternsForCategory(category)
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  // Mirror the main /properties route's filter parsing. We don't import
  // those helpers directly because that route's GET handler is its
  // public interface — keeping the export path self-contained means a
  // tweak to one doesn't silently change the other.
  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const zipPrefix = sp.get("zip_prefix")?.trim() || parsed.zipPrefix
  const county = sp.get("county")?.trim() || parsed.county
  const stateAbbr = sp.get("state")?.trim().toUpperCase() || null

  const minSqft = parseNumber(sp.get("min_sqft"))
  const maxSqft = parseNumber(sp.get("max_sqft"))
  const minYear = parseNumber(sp.get("min_year"))
  const maxYear = parseNumber(sp.get("max_year"))
  const minValue = parseNumber(sp.get("min_value"))
  const maxValue = parseNumber(sp.get("max_value"))
  const ownerType = (sp.get("owner_type") || "all").toLowerCase()

  // Property-type filter — same rollup categories as the main route.
  const typesRaw = sp.get("property_types")
  const typeCategories = typesRaw
    ? typesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : []

  // Refuse to export the entire universe.
  const haveLocation = !!(stateAbbr || zip || zipPrefix || county || city)
  if (!haveLocation) {
    return NextResponse.json(
      { error: "Refusing to export without at least one location filter (state, zip, county, or city)." },
      { status: 400 }
    )
  }

  const db = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db
    .from("intel_properties")
    .select(SELECT_COLUMNS)
    .in("source_detail", PROPERTY_SOURCES)
    .not("street_address", "is", null)
    .not("city", "is", null)
    .not("state", "is", null)

  if (stateAbbr) q = q.eq("state", stateAbbr)
  if (zip) q = q.eq("postal_code", zip)
  else if (zipPrefix) q = q.like("postal_code", `${zipPrefix}%`)
  if (city) q = q.ilike("city", `%${city}%`)
  if (county) q = q.ilike("county", `%${county}%`)

  if (minSqft != null) q = q.gte("building_sqft", minSqft)
  if (maxSqft != null) q = q.lte("building_sqft", maxSqft)
  if (minYear != null) q = q.gte("year_built", minYear)
  if (maxYear != null) q = q.lte("year_built", maxYear)
  if (minValue != null) q = q.gte("estimated_value", minValue)
  if (maxValue != null) q = q.lte("estimated_value", maxValue)
  if (ownerType === "corporate") q = q.eq("corporate_owned", true)
  else if (ownerType === "individual") q = q.or("corporate_owned.eq.false,corporate_owned.is.null")

  if (typeCategories.length > 0) {
    const orParts: string[] = []
    let includeOther = false
    for (const cat of typeCategories) {
      if (cat === "Other") {
        includeOther = true
        continue
      }
      for (const p of buildIlikeOr(cat)) {
        // Quoted to escape commas / colons / parens inside the pattern.
        orParts.push(`property_type.ilike."%${p}%"`)
      }
    }
    if (includeOther) orParts.push("property_type.is.null")
    if (orParts.length > 0) q = q.or(orParts.join(","))
  }

  q = q.order("building_sqft", { ascending: false, nullsFirst: false }).limit(EXPORT_CAP)

  const res = await q
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 })
  }

  type Row = Record<string, unknown>
  const rows = (res.data ?? []) as Row[]

  const lines: string[] = [CSV_HEADER]
  for (const r of rows) {
    lines.push([
      csvEscape(r.street_address),
      csvEscape(r.city),
      csvEscape(r.state),
      csvEscape(r.postal_code),
      csvEscape(r.owner_name ?? r.raw_owner_name),
      csvEscape(r.building_sqft),
      csvEscape(r.year_built),
      csvEscape(r.estimated_value),
      csvEscape(r.property_type),
    ].join(","))
  }
  const csv = lines.join("\r\n") + "\r\n"

  // Friendly filename: "dilly-intel_<city>-<state>.csv".
  const slug = [city, stateAbbr].filter(Boolean).join("-").toLowerCase().replace(/\s+/g, "-") || "export"
  const filename = `dilly-intel_${slug}.csv`

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Row-Count": String(rows.length),
      "X-Row-Cap": String(EXPORT_CAP),
    },
  })
}
