import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  patternsForCategory,
  ALL_ROLLUP_PATTERNS,
  ROLLUP_CATEGORIES,
} from "@/lib/intel/property-types"

export const dynamic = "force-dynamic"

/** Apply a rollup-category property-type filter to a PostgREST query.
 *  See ../route.ts for the include / "Other" semantics. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTypeFilter(q: any, category: string | null): any {
  if (!category) return q
  if (!(ROLLUP_CATEGORIES as readonly string[]).includes(category)) return q
  if (category === "Other") {
    let out = q
    for (const p of ALL_ROLLUP_PATTERNS) {
      out = out.not("property_type", "ilike", `%${p}%`)
    }
    return out
  }
  const pats = patternsForCategory(category)
  if (pats.length === 0) return q
  return q.or(pats.map((p) => `property_type.ilike."%${p}%"`).join(","))
}

// ----------------------------------------------------------------------------
// Portfolio CSV export. Mirrors the data filter used by the panel JSON
// endpoint (../route.ts) but streams a CSV body instead of JSON. Capped at
// 5,000 rows — five times the panel's render cap to allow exporting the
// long tail of a single large institutional portfolio (TX SFR REIT-scale)
// without exposing a full-table dump path.
// ----------------------------------------------------------------------------

const EXPORT_CAP = 5_000

const PROPERTY_SOURCES = [
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

const SELECT_COLUMNS = [
  "street_address", "city", "state", "postal_code",
  "owner_name", "raw_owner_name",
  "owner_mailing_address", "owner_mailing_city", "owner_mailing_state", "owner_mailing_zip",
  "building_sqft", "lot_size_sqft", "year_built",
  "estimated_value", "property_type", "apn",
].join(",")

const CSV_HEADER = [
  "street_address",
  "city",
  "state",
  "zip",
  "owner_name",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "building_sqft",
  "lot_size_sqft",
  "year_built",
  "estimated_value",
  "property_type",
  "apn",
].join(",")

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
  "memphis housing", "shelby county", "development economic",
]

function isGovernmentOwner(name: string | null | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  for (const p of GOV_PATTERNS) if (lower.includes(p)) return true
  return false
}

function csvEscape(v: unknown): string {
  if (v == null) return ""
  const s = String(v)
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildClusterFilter(
  addresses: string[],
  stem: string | null,
  owner: string | null,
): string | null {
  const parts: string[] = []
  for (const a of addresses) {
    if (!a) continue
    parts.push(`owner_mailing_address.eq."${a.replace(/"/g, '""')}"`)
  }
  if (stem) {
    const safe = stem.replace(/%/g, "").replace(/"/g, '""')
    if (safe.length >= 3) parts.push(`owner_name.ilike."%${safe}%"`)
  }
  if (owner) {
    parts.push(`owner_name.eq."${owner.replace(/"/g, '""')}"`)
  }
  return parts.length === 0 ? null : parts.join(",")
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const sp = req.nextUrl.searchParams
  const state = sp.get("state")?.trim().toUpperCase() || null
  if (!state) {
    return NextResponse.json(
      { error: "State parameter required" },
      { status: 400 },
    )
  }

  const addresses = sp
    .getAll("address")
    .map((a) => a.trim())
    .filter(Boolean)
  const stem = sp.get("stem")?.trim().toLowerCase() || null
  const owner = sp.get("owner")?.trim() || null
  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"
  const filenameHint = sp.get("name")?.trim() || null
  const propertyType = sp.get("property_type")?.trim() || null

  const orFilter = buildClusterFilter(addresses, stem, owner)
  if (!orFilter) {
    return NextResponse.json(
      { error: "At least one of address, stem, or owner is required." },
      { status: 400 },
    )
  }

  const db = createAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db
    .from("intel_properties")
    .select(SELECT_COLUMNS)
    .in("source_detail", PROPERTY_SOURCES)
    .eq("state", state)
    .not("street_address", "is", null)
    .or(orFilter)
  q = applyTypeFilter(q, propertyType)
  const res = await q
    .order("estimated_value", { ascending: false, nullsFirst: false })
    .limit(EXPORT_CAP)

  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 })
  }

  type Row = Record<string, unknown>
  // PostgREST's typed select returns a generic-error union for SELECT
  // strings it can't statically resolve (the embedded entity join in
  // particular). The runtime shape is plain rows once .error is null,
  // which we've already short-circuited above — cast through unknown.
  let rows = ((res.data ?? []) as unknown as Row[])

  if (hideGov) {
    rows = rows.filter(
      (r) =>
        !isGovernmentOwner((r.owner_name as string | null) ?? null) &&
        !isGovernmentOwner((r.raw_owner_name as string | null) ?? null),
    )
  }

  const lines: string[] = [CSV_HEADER]
  for (const r of rows) {
    lines.push([
      csvEscape(r.street_address),
      csvEscape(r.city),
      csvEscape(r.state),
      csvEscape(r.postal_code),
      csvEscape(r.owner_name ?? r.raw_owner_name),
      csvEscape(r.owner_mailing_address),
      csvEscape(r.owner_mailing_city),
      csvEscape(r.owner_mailing_state),
      csvEscape(r.owner_mailing_zip),
      csvEscape(r.building_sqft),
      csvEscape(r.lot_size_sqft),
      csvEscape(r.year_built),
      csvEscape(r.estimated_value),
      csvEscape(r.property_type),
      csvEscape(r.apn),
    ].join(","))
  }
  const csv = lines.join("\r\n") + "\r\n"

  // Filename: prefer the human label passed in, fall back to the path id.
  const slug = (filenameHint ?? decodeURIComponent(id))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "portfolio"
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
