import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"

export const dynamic = "force-dynamic"

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

function parseInt0(v: string | null, fallback: number, max: number): number {
  if (!v) return fallback
  const n = parseInt(v, 10)
  if (isNaN(n)) return fallback
  return Math.max(1, Math.min(max, n))
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  // Single search input -> parsed into city/zip/zipPrefix/county.
  // Explicit ?city=, ?zip=, ?county= override.
  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const zipPrefix = sp.get("zip_prefix")?.trim() || parsed.zipPrefix
  const county = sp.get("county")?.trim() || parsed.county

  const state = sp.get("state")?.trim().toUpperCase() || null
  const minProperties = parseInt0(sp.get("min_properties"), 2, 10_000)
  const limit = parseInt0(sp.get("limit"), 100, 500)

  // Hide-government toggle. Default ON to match the market UI default.
  // Pass ?hide_gov=false to disable.
  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

  const db = createAdminClient()

  const effectiveZip = zip ?? null

  const { data, error } = await db.rpc("intel_owners_concentration", {
    p_city: city,
    p_state: state,
    p_zip: effectiveZip,
    p_county: county,
    p_min_properties: minProperties,
    p_limit: limit,
    p_hide_gov: hideGov,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as OwnerRow[]

  return NextResponse.json({
    filters: {
      city, state, zip: effectiveZip, zip_prefix: zipPrefix, county,
      min_properties: minProperties, limit, hide_gov: hideGov,
    },
    count: rows.length,
    owners: rows,
  })
}
