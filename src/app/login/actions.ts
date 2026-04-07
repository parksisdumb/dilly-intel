"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"

export async function login(formData: FormData) {
  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  })

  if (error) return { error: error.message }

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Authentication failed" }

  const admin = createAdminClient()
  const { data: icp } = await admin
    .from("icp_profiles")
    .select("id")
    .eq("user_id", user.id)
    .limit(1)

  if (!icp || icp.length === 0) redirect("/setup")
  redirect("/dashboard")
}

export async function signup(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()

  const email = formData.get("email") as string
  const password = formData.get("password") as string
  const name = formData.get("name") as string
  const company = formData.get("company") as string

  const { data: authData, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) return { error: error.message }
  if (!authData.user) return { error: "Signup failed" }

  const { data: org, error: orgError } = await admin
    .from("orgs")
    .insert({ name: company })
    .select()
    .single()

  if (orgError) return { error: "Failed to create organization" }

  const { error: userError } = await admin.from("users").insert({
    id: authData.user.id,
    email,
    full_name: name,
    org_id: org.id,
  })

  if (userError) return { error: "Failed to create user profile" }

  redirect("/setup")
}
