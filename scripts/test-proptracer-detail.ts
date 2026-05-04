import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { fetchPropertyDetail } from '../src/lib/intel/proptracer/proptracer-client'
import { buildEntityIndex, resolveEntity } from '../src/lib/intel/proptracer/entity-resolver'
import { createAdminClient } from '../src/lib/supabase/admin'

async function main() {
  const detail = await fetchPropertyDetail('36280369')
  console.log('=== normalized detail ===')
  console.log(JSON.stringify(detail, null, 2))

  if (detail?.raw_owner_name) {
    const db = createAdminClient()
    console.log()
    console.log('Building entity index...')
    const idx = await buildEntityIndex(db)
    console.log(`  exact: ${idx.exact.size}, normalized: ${idx.normalized.size}, subsidiary: ${idx.subsidiary.size}`)
    const resolved = resolveEntity(detail.raw_owner_name, idx)
    console.log()
    console.log('=== resolveEntity result ===')
    console.log('raw_owner_name:', detail.raw_owner_name)
    console.log('resolved:', JSON.stringify(resolved))
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
