import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET() {
  const db = createAdminClient()

  const [properties, entities, contacts, prospects] = await Promise.all([
    db.from("intel_properties").select("*", { count: "exact", head: true }),
    db.from("intel_entities").select("*", { count: "exact", head: true }),
    db.from("intel_contacts").select("*", { count: "exact", head: true }),
    db.from("intel_prospects").select("*", { count: "exact", head: true }),
  ])

  // Most recent record timestamp
  const [latestProp, latestEntity, latestContact, latestProspect] =
    await Promise.all([
      db.from("intel_properties").select("created_at").order("created_at", { ascending: false }).limit(1).single(),
      db.from("intel_entities").select("created_at").order("created_at", { ascending: false }).limit(1).single(),
      db.from("intel_contacts").select("created_at").order("created_at", { ascending: false }).limit(1).single(),
      db.from("intel_prospects").select("created_at").order("created_at", { ascending: false }).limit(1).single(),
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

  return NextResponse.json({
    properties: properties.count || 0,
    entities: entities.count || 0,
    contacts: contacts.count || 0,
    prospects: prospects.count || 0,
    lastUpdated,
  })
}
