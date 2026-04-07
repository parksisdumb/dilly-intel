"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function pushToDilly(type: "entity" | "property", data: any) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const admin = createAdminClient()

  const { data: userData } = await admin
    .from("users")
    .select("org_id")
    .eq("id", user.id)
    .single()

  if (!userData) return { error: "User not found" }

  try {
    const res = await fetch(
      `${process.env.DILLY_API_URL}/api/intel/receive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dilly-Intel-Secret": process.env.DILLY_API_SECRET!,
        },
        body: JSON.stringify({
          type,
          data,
          source_org_id: userData.org_id,
          source_user_id: user.id,
        }),
      }
    )

    await admin.from("push_log").insert({
      org_id: userData.org_id,
      user_id: user.id,
      intel_property_id: type === "property" ? data.id : null,
      intel_entity_id: type === "entity" ? data.id : null,
      destination: "dilly",
      status: res.ok ? "success" : "error",
      error_message: res.ok ? null : `HTTP ${res.status}`,
    })

    if (!res.ok) return { error: `Push failed (${res.status})` }
    return { success: true }
  } catch (e: any) {
    await admin.from("push_log").insert({
      org_id: userData.org_id,
      user_id: user.id,
      intel_property_id: type === "property" ? data.id : null,
      intel_entity_id: type === "entity" ? data.id : null,
      destination: "dilly",
      status: "error",
      error_message: e.message,
    })

    return { error: e.message }
  }
}
