import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET() {
  const db = createAdminClient()
  const { data, error } = await db
    .from("agent_registry")
    .select("*")
    .order("agent_name")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const { agent_name, enabled } = await req.json()
  const db = createAdminClient()

  const { error } = await db
    .from("agent_registry")
    .update({ enabled })
    .eq("agent_name", agent_name)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
