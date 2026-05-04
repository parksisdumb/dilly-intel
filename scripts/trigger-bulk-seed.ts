import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { Inngest } from 'inngest'

async function main() {
  const inngest = new Inngest({
    id: 'dilly-intel',
    eventKey: process.env.INNGEST_EVENT_KEY
  })

  await inngest.send({
    name: 'app/edgar_bulk_seed.run',
    data: { triggered_by: 'manual_bulk_seed' }
  })

  console.log('Bulk seed triggered successfully')
}

main().catch(console.error)
