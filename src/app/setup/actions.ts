"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function saveICP(data: {
  target_cities: string[]
  target_states: string[]
  target_metros: string[]
  target_account_types: string[]
  min_sq_footage: number | null
  max_sq_footage: number | null
  target_property_types: string[]
  target_roof_types: string[]
  min_deal_size: number | null
  max_deal_size: number | null
  target_decision_maker_titles: string[]
}) {
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

  if (!userData) return { error: "User profile not found" }

  const { error } = await admin.from("icp_profiles").insert({
    org_id: userData.org_id,
    user_id: user.id,
    ...data,
  })

  if (error) return { error: error.message }
  return { success: true }
}
