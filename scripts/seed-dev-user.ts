import { createClient } from "@supabase/supabase-js"
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const DEV_USER = {
  email: "dev@dillyintel.com",
  password: "dilly3001!",
  name: "Dev User",
  company: "Dilly Intel Dev",
}

async function seed() {
  console.log("Seeding dev user...")

  // 1. Create auth user
  const { data: authData, error: authError } =
    await supabase.auth.admin.createUser({
      email: DEV_USER.email,
      password: DEV_USER.password,
      email_confirm: true,
    })

  if (authError) {
    if (authError.message.includes("already been registered")) {
      console.log("Auth user already exists, skipping...")
      const { data: users } = await supabase.auth.admin.listUsers()
      const existing = users?.users.find((u) => u.email === DEV_USER.email)
      if (!existing) {
        console.error("Could not find existing user")
        process.exit(1)
      }
      console.log(`Auth user ID: ${existing.id}`)
      return
    }
    console.error("Auth error:", authError.message)
    process.exit(1)
  }

  const userId = authData.user.id
  console.log(`Auth user created: ${userId}`)

  // 2. Create org
  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .insert({ name: DEV_USER.company })
    .select()
    .single()

  if (orgError) {
    console.error("Org error:", orgError.message)
    process.exit(1)
  }
  console.log(`Org created: ${org.id}`)

  // 3. Create user profile
  const { error: userError } = await supabase.from("users").insert({
    id: userId,
    email: DEV_USER.email,
    full_name: DEV_USER.name,
    org_id: org.id,
  })

  if (userError) {
    console.error("User profile error:", userError.message)
    process.exit(1)
  }

  console.log("\nDev user seeded successfully!")
  console.log("─────────────────────────────")
  console.log(`Email:    ${DEV_USER.email}`)
  console.log(`Password: ${DEV_USER.password}`)
  console.log("─────────────────────────────")
}

seed()
