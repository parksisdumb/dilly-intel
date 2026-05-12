import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET() {
  const db = createAdminClient()

  // `estimated` reads pg_class.reltuples after ANALYZE — accurate within
  // ~1% and millisecond-fast. `exact` was timing out on intel_properties
  // (~1M rows + concurrent ingest), causing the route to return count=null
  // which the UI rendered as 0. The latest-record timestamps below give
  // freshness; the count itself doesn't need to be transactionally exact.
  const COUNT_MODE = "estimated" as const

  const [properties, entities, contacts, prospects] = await Promise.all([
    db.from("intel_properties").select("*", { count: COUNT_MODE, head: true }),
    db.from("intel_entities").select("*", { count: COUNT_MODE, head: true }),
    db.from("intel_contacts").select("*", { count: COUNT_MODE, head: true }),
    db.from("intel_prospects").select("*", { count: COUNT_MODE, head: true }),
  ])

  // Most recent record timestamp. `maybeSingle` so an empty table returns
  // data:null instead of throwing — otherwise a fresh prospects table
  // would 500 the whole route.
  const [latestProp, latestEntity, latestContact, latestProspect] =
    await Promise.all([
      db.from("intel_properties").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("intel_entities").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("intel_contacts").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("intel_prospects").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ])

  const timestamps = [
    latestProp.data?.created_at,
    latestEntity.data?.created_at,
    latestContact.data?.created_at,
    latestProspect.data?.created_at,
  ].filter(Boolean) as string[]

  const lastUpdated = timestamps.length > 0
    ? timestamps.sort().reverse()[0]
    : null

  // Surface count errors in the response so the ops dashboard can
  // distinguish "actually zero" from "query failed" instead of falling
  // through to 0 silently.
  const errors: Record<string, string> = {}
  if (properties.error) errors.properties = properties.error.message
  if (entities.error) errors.entities = entities.error.message
  if (contacts.error) errors.contacts = contacts.error.message
  if (prospects.error) errors.prospects = prospects.error.message

  return NextResponse.json({
    properties: properties.count ?? 0,
    entities: entities.count ?? 0,
    contacts: contacts.count ?? 0,
    prospects: prospects.count ?? 0,
    lastUpdated,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  })
}
