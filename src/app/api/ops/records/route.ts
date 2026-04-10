import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const TABLE_MAP: Record<string, { table: string; columns: string }> = {
  properties: {
    table: "intel_properties",
    columns: "id, property_name, street_address, city, state, property_type, owner_name, source_detail, confidence_score, created_at",
  },
  entities: {
    table: "intel_entities",
    columns: "id, name, entity_type, total_properties, hq_city, hq_state, source_detail, created_at",
  },
  contacts: {
    table: "intel_contacts",
    columns: "id, full_name, title, contact_type, email, phone, source_detail, confidence_score, created_at",
  },
  prospects: {
    table: "intel_prospects",
    columns: "id, company_name, city, state, contact_first_name, contact_last_name, contact_title, source_detail, status, created_at",
  },
}

export async function GET(req: NextRequest) {
  const tab = req.nextUrl.searchParams.get("tab") || "properties"
  const config = TABLE_MAP[tab]
  if (!config) return NextResponse.json({ error: "invalid tab" }, { status: 400 })

  const db = createAdminClient()
  const { data, error } = await db
    .from(config.table)
    .select(config.columns)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
