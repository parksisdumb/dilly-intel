import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { rollupCategory } from "@/lib/intel/property-types"

export const dynamic = "force-dynamic"

// ----------------------------------------------------------------------------
// Portfolio detail endpoint.
//
// Fetches every property attached to one portfolio cluster, plus a roll-up of
// the cluster's stats (sqft / value / type breakdown / LLC list).
//
//   GET /api/intelligence/portfolios/<encoded-primary-address>?
//     state=TN                              required
//     &address=<addr1>&address=<addr2>...   one per mailing address in the cluster
//     &stem=olymbec                         optional, for stem-merged clusters
//     &owner=<exact owner_name>             optional, used by the property-card
//                                            "click the owner name" entry point
//
// The path id is a cosmetic, URL-safe handle for the primary mailing address;
// real filtering rides on the query string so the same handle can survive a
// label rename or a re-cluster.
//
// Performance: caps the property list at 1000 rows and filters by
// `state` + `source_detail IN (intel_market_sources())` so the partial index
// covers the read. Times out cleanly via the connection's default budget.
// ----------------------------------------------------------------------------

// Match the property browser's universe exactly — same sources, same column
// projection. Keeps the index predicates valid.
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
]

const SELECT_COLUMNS = [
  "id",
  "street_address",
  "city",
  "state",
  "postal_code",
  "county",
  "latitude",
  "longitude",
  "property_type",
  "property_name",
  "building_sqft",
  "lot_size_sqft",
  "year_built",
  "estimated_value",
  "owner_name",
  "raw_owner_name",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "corporate_owned",
  "absentee_owner",
  "apn",
  "entity_id",
  "proptracer_id",
  "enrichment_status",
  "source_detail",
  "updated_at",
  "intel_entities!entity_id(id,name,entity_type,ticker,total_properties)",
].join(",")

// Government-owner patterns. Kept in sync with the other /intelligence
// routes — see src/app/api/intelligence/market/route.ts for the why.
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

// Hard ceiling on properties returned per request — the panel renders this
// in a single table, and the largest legitimate portfolio we've seen (Belz)
// has ~60 properties. 1000 leaves headroom for whatever Olymbec-scale
// clusters surface in larger markets without blowing up the slide-in.
const PROPERTY_CAP = 1000

type EntityJoin = {
  id: string
  name: string
  entity_type: string | null
  ticker: string | null
  total_properties: number | null
}

type RawRow = {
  id: string
  street_address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  county: string | null
  latitude: number | null
  longitude: number | null
  property_type: string | null
  property_name: string | null
  building_sqft: number | null
  lot_size_sqft: number | null
  year_built: number | null
  estimated_value: number | null
  owner_name: string | null
  raw_owner_name: string | null
  owner_mailing_address: string | null
  owner_mailing_city: string | null
  owner_mailing_state: string | null
  owner_mailing_zip: string | null
  corporate_owned: boolean | null
  absentee_owner: boolean | null
  apn: string | null
  entity_id: string | null
  proptracer_id: string | null
  enrichment_status: string | null
  source_detail: string | null
  updated_at: string | null
  intel_entities: EntityJoin | EntityJoin[] | null
}

/**
 * Build the PostgREST `.or(...)` filter that matches any property in the
 * cluster. Combines exact-mailing-address matches, optional stem-name
 * matches, and an exact owner-name match (the property-card click path).
 *
 * Returns null if there's nothing to filter by — the caller bails 400.
 */
function buildClusterFilter(
  addresses: string[],
  stem: string | null,
  owner: string | null,
): string | null {
  const parts: string[] = []
  for (const a of addresses) {
    if (!a) continue
    // PostgREST .or() uses commas as delimiters and `.` as the
    // operator separator. Wrap values in double-quotes so embedded
    // commas / parens (common in mailing addresses like "100 Main,
    // Ste 200") don't trip the parser.
    parts.push(`owner_mailing_address.eq."${a.replace(/"/g, '""')}"`)
  }
  if (stem) {
    // Stem-merged clusters can have LLCs at addresses we didn't see in
    // the original cluster row (rare-but-real long tail). Sweep them in
    // by owner_name ilike '%STEM%'. Still scoped to state at the
    // request level, so we're not scanning the whole table.
    const safe = stem.replace(/%/g, "").replace(/"/g, '""')
    if (safe.length >= 3) parts.push(`owner_name.ilike."%${safe}%"`)
  }
  if (owner) {
    parts.push(`owner_name.eq."${owner.replace(/"/g, '""')}"`)
  }
  return parts.length === 0 ? null : parts.join(",")
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === "number" ? v : parseFloat(v)
  return isFinite(n) ? n : 0
}

function normalizeEntity(e: EntityJoin | EntityJoin[] | null): EntityJoin | null {
  if (!e) return null
  return Array.isArray(e) ? (e[0] ?? null) : e
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // Touch the path param so Next's typed-routes plumbing sees it consumed
  // (we don't actually filter by it — it's a cosmetic handle).
  await ctx.params

  const sp = req.nextUrl.searchParams
  const state = sp.get("state")?.trim().toUpperCase() || null

  if (!state) {
    return NextResponse.json(
      { error: "State parameter required" },
      { status: 400 },
    )
  }

  // Addresses are passed once per cluster member. Empty / whitespace
  // tolerated — filtered out in the builder.
  const addresses = sp
    .getAll("address")
    .map((a) => a.trim())
    .filter(Boolean)
  const stem = sp.get("stem")?.trim().toLowerCase() || null
  const owner = sp.get("owner")?.trim() || null
  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

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
    .order("estimated_value", { ascending: false, nullsFirst: false })
    .limit(PROPERTY_CAP)

  // Optional pre-filter — if the caller knows it's an exact-mailing-
  // address cluster (no stem widening), skip the OR machinery entirely
  // by passing `?strict=1`. Faster, but the panel doesn't currently set
  // this — kept as an escape hatch.
  if (sp.get("strict") === "1" && addresses.length > 0 && !stem && !owner) {
    q = q.in("owner_mailing_address", addresses)
  }

  const res = await q
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 })
  }

  let rows = ((res.data ?? []) as RawRow[]).filter(
    (r) => r.street_address && r.city && r.state,
  )

  // Government filter — applied JS-side per project convention. Drops
  // gov-named rows so the panel matches what the market dashboard
  // surfaced. Belt-and-suspenders since the entry points already
  // exclude gov entities at the cluster level.
  if (hideGov) {
    rows = rows.filter(
      (r) =>
        !isGovernmentOwner(r.owner_name) &&
        !isGovernmentOwner(r.raw_owner_name),
    )
  }

  // ----- Roll up summary stats over the returned rows ------------------
  let totalSqft = 0
  let sqftCount = 0
  let totalValue = 0
  let valueCount = 0
  let yearSum = 0
  let yearCount = 0

  const typeCounts = new Map<string, number>()      // raw property_type
  const rollupCounts = new Map<string, number>()    // rolled-up category
  const ownerCounts = new Map<string, number>()     // owner_name -> count
  const mailingAddrMap = new Map<
    string,
    {
      address: string
      city: string | null
      state: string | null
      zip: string | null
      property_count: number
    }
  >()
  let primaryEntity: EntityJoin | null = null

  for (const r of rows) {
    if (r.building_sqft) {
      totalSqft += num(r.building_sqft)
      sqftCount++
    }
    if (r.estimated_value) {
      totalValue += num(r.estimated_value)
      valueCount++
    }
    if (r.year_built && r.year_built > 1800 && r.year_built < 2100) {
      yearSum += r.year_built
      yearCount++
    }
    if (r.property_type) {
      typeCounts.set(r.property_type, (typeCounts.get(r.property_type) ?? 0) + 1)
      const cat = rollupCategory(r.property_type)
      rollupCounts.set(cat, (rollupCounts.get(cat) ?? 0) + 1)
    } else {
      rollupCounts.set("Other", (rollupCounts.get("Other") ?? 0) + 1)
    }
    const owner = r.owner_name ?? r.raw_owner_name
    if (owner) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1)

    if (r.owner_mailing_address) {
      const key = [
        r.owner_mailing_address.toUpperCase().trim(),
        (r.owner_mailing_city ?? "").toUpperCase().trim(),
        (r.owner_mailing_state ?? "").toUpperCase().trim(),
      ].join("|")
      const existing = mailingAddrMap.get(key)
      if (existing) {
        existing.property_count++
      } else {
        mailingAddrMap.set(key, {
          address: r.owner_mailing_address,
          city: r.owner_mailing_city,
          state: r.owner_mailing_state,
          zip: r.owner_mailing_zip,
          property_count: 1,
        })
      }
    }

    const e = normalizeEntity(r.intel_entities)
    if (e && !primaryEntity) primaryEntity = e
  }

  const llcs = Array.from(ownerCounts.entries())
    .map(([name, count]) => ({ name, property_count: count }))
    .sort((a, b) => b.property_count - a.property_count)

  const propertyTypeBreakdown = Array.from(rollupCounts.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count)

  const mailingAddresses = Array.from(mailingAddrMap.values()).sort(
    (a, b) => b.property_count - a.property_count,
  )

  // Shape each row into the same Property type the property browser uses
  // — that way PropertyDetailPanel can consume them verbatim when the
  // user clicks through to an individual property from the table.
  const properties = rows.map((r) => ({
    id: r.id,
    street_address: r.street_address,
    city: r.city,
    state: r.state,
    postal_code: r.postal_code,
    county: r.county,
    latitude: r.latitude,
    longitude: r.longitude,
    property_type: r.property_type,
    property_name: r.property_name,
    building_sqft: r.building_sqft,
    lot_size_sqft: r.lot_size_sqft,
    year_built: r.year_built,
    estimated_value: r.estimated_value,
    owner_name: r.owner_name,
    raw_owner_name: r.raw_owner_name,
    owner_mailing_address: r.owner_mailing_address,
    owner_mailing_city: r.owner_mailing_city,
    owner_mailing_state: r.owner_mailing_state,
    owner_mailing_zip: r.owner_mailing_zip,
    corporate_owned: r.corporate_owned,
    absentee_owner: r.absentee_owner,
    apn: r.apn,
    proptracer_id: r.proptracer_id,
    enrichment_status: r.enrichment_status,
    entity: normalizeEntity(r.intel_entities),
    satellite_url: null, // panel doesn't render thumbnails per row
    updated_at: r.updated_at,
  }))

  return NextResponse.json({
    filters: { state, addresses, stem, owner, hide_gov: hideGov },
    summary: {
      property_count: rows.length,
      capped: rows.length >= PROPERTY_CAP,
      total_sqft: sqftCount > 0 ? totalSqft : null,
      sqft_coverage: rows.length > 0 ? sqftCount / rows.length : 0,
      total_estimated_value: valueCount > 0 ? totalValue : null,
      value_coverage: rows.length > 0 ? valueCount / rows.length : 0,
      avg_year_built: yearCount > 0 ? Math.round(yearSum / yearCount) : null,
      distinct_owners: llcs.length,
      distinct_mailing_addresses: mailingAddresses.length,
    },
    entity: primaryEntity,
    property_types: propertyTypeBreakdown,
    llcs,
    mailing_addresses: mailingAddresses,
    properties,
  })
}
