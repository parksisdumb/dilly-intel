import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"

export const dynamic = "force-dynamic"

// Government-owner patterns. Duplicated from src/app/api/intelligence/
// market/route.ts on purpose — both endpoints filter portfolios by the
// same rule, but we don't want the main route's bundle reaching into
// this one or vice versa. If you change one list, change the other.
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
  for (const p of GOV_PATTERNS) {
    if (lower.includes(p)) return true
  }
  return false
}

type PortfolioRow = {
  owner_mailing_address: string
  owner_mailing_city: string | null
  owner_mailing_state: string | null
  owner_mailing_zip: string | null
  property_count: number
  llc_names: string[] | null
  total_sqft: number | null
  total_value: number | null
}

/**
 * Standalone portfolio-clustering endpoint. Split out from the main
 * /api/intelligence/market call so a slow GROUP BY on
 * owner_mailing_address (the heaviest of the four queries that route
 * was making) doesn't block the headline KPIs and top-owner tables.
 *
 * The market page calls this endpoint after the main request returns;
 * if it takes 5-10s to come back the rest of the dashboard is already
 * interactive.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const county = sp.get("county")?.trim() || parsed.county
  const state = sp.get("state")?.trim().toUpperCase() || null

  // Safety net for the frontend state gate. The mailing-address GROUP BY
  // is the heaviest query in the dashboard — an unfiltered run trips the
  // statement timeout, so bail out before the RPC call.
  if (!state) {
    return NextResponse.json(
      { error: "State parameter required" },
      { status: 400 }
    )
  }

  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

  const db = createAdminClient()

  const res = await db.rpc("intel_mailing_address_portfolios", {
    p_city: city,
    p_state: state,
    p_zip: zip,
    p_county: county,
    p_min_properties: 3,
    p_limit: 50,
  })

  if (res.error) {
    // Don't 500 — return an empty list with the error attached so the
    // UI can render the section's empty state and surface the message
    // in dev tools without breaking the page.
    return NextResponse.json(
      {
        portfolio_owners: [],
        error: res.error.message,
      },
      { status: 200 }
    )
  }

  const portfolios = ((res.data ?? []) as PortfolioRow[])
    .filter((p) => {
      if (!hideGov) return true
      const llcs = p.llc_names ?? []
      return !llcs.some(isGovernmentOwner)
    })
    .map((p) => ({
      mailing_address: p.owner_mailing_address,
      mailing_city: p.owner_mailing_city,
      mailing_state: p.owner_mailing_state,
      mailing_zip: p.owner_mailing_zip,
      property_count: Number(p.property_count) || 0,
      llc_names: p.llc_names ?? [],
      total_sqft: p.total_sqft ?? null,
      total_value: p.total_value ?? null,
    }))

  return NextResponse.json({
    filters: { city, state, zip, county, hide_gov: hideGov },
    portfolio_owners: portfolios,
  })
}
