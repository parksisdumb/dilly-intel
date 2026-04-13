import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function main() {
  // Query 1: count intel_entities
  const { count, error: e1 } = await db
    .from('intel_entities')
    .select('*', { count: 'exact', head: true })

  if (e1) {
    console.error('intel_entities count error:', e1.message)
  } else {
    console.log('intel_entities count:', count)
  }

  // Query 2: edgar_intelligence agent config
  const { data, error: e2 } = await db
    .from('agent_registry')
    .select('agent_name, config')
    .eq('agent_name', 'edgar_intelligence')
    .single()

  if (e2) {
    console.error('agent_registry error:', e2.message)
  } else {
    console.log('agent_registry row:', JSON.stringify(data, null, 2))
  }
}

main()
