import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"
import { DashboardClient } from "./dashboard-client"

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const admin = createAdminClient()

  // Get active ICP profile
  const { data: icp } = await admin
    .from("icp_profiles")
    .select("*")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (!icp) redirect("/setup")

  const targetCities = icp.target_cities || []
  const targetStates = icp.target_states || []

  // Build OR filter for territory queries
  const filters: string[] = []
  if (targetCities.length > 0) {
    filters.push(`city.in.(${targetCities.join(",")})`)
  }
  if (targetStates.length > 0) {
    filters.push(`state.in.(${targetStates.join(",")})`)
  }
  const orFilter = filters.length > 0 ? filters.join(",") : "id.is.null"

  // Step 1: Get territory properties with count
  const { data: territoryProps, count: propertyCount } = await admin
    .from("intel_properties")
    .select("id, entity_id, owner_name", { count: "exact" })
    .or(orFilter)
    .limit(500)

  const tProps = territoryProps || []
  const entityIds = [
    ...new Set(tProps.map((p) => p.entity_id).filter(Boolean)),
  ] as string[]

  // Coverage calculation
  const totalForCoverage = tProps.length
  const withOwner = tProps.filter((p) => p.owner_name).length
  const coverage =
    totalForCoverage > 0
      ? Math.round((withOwner / totalForCoverage) * 100)
      : 0

  // Step 2: Parallel detail queries
  const parallelQueries: Promise<any>[] = [
    // Properties with details for the table
    admin
      .from("intel_properties")
      .select("*, intel_entities(name)")
      .or(orFilter)
      .order("confidence_score", { ascending: false })
      .limit(100),
  ]

  if (entityIds.length > 0) {
    parallelQueries.push(
      // Entities
      admin
        .from("intel_entities")
        .select("*")
        .in("id", entityIds)
        .order("total_properties", { ascending: false, nullsFirst: false })
        .limit(50),
      // Contact count
      admin
        .from("intel_contacts")
        .select("*", { count: "exact", head: true })
        .in("entity_id", entityIds)
    )
  }

  const results = await Promise.all(parallelQueries)
  const properties = results[0].data || []
  const entities = entityIds.length > 0 ? results[1].data || [] : []
  const contactCount =
    entityIds.length > 0 ? results[2]?.count || 0 : 0

  // Compute territory property counts per entity
  const entityTerritoryCounts: Record<string, number> = {}
  for (const p of tProps) {
    if (p.entity_id) {
      entityTerritoryCounts[p.entity_id] =
        (entityTerritoryCounts[p.entity_id] || 0) + 1
    }
  }

  const entitiesWithCounts = entities
    .map((e: any) => ({
      ...e,
      territory_properties: entityTerritoryCounts[e.id] || 0,
    }))
    .sort(
      (a: any, b: any) => b.territory_properties - a.territory_properties
    )

  return (
    <DashboardClient
      icp={icp}
      stats={{
        propertyCount: propertyCount || 0,
        entityCount: entityIds.length,
        contactCount,
        coverage,
      }}
      entities={entitiesWithCounts}
      properties={properties}
      targetCities={targetCities}
    />
  )
}
