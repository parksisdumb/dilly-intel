import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const admin = createAdminClient()
  const { data: icp } = await admin
    .from("icp_profiles")
    .select("id")
    .eq("user_id", user.id)
    .limit(1)

  if (!icp || icp.length === 0) redirect("/setup")
  redirect("/dashboard")
}
