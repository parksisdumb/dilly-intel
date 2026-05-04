import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { Inngest } from 'inngest'

async function main() {
  const inngest = new Inngest({
    id: 'dilly-intel',
    eventKey: process.env.INNGEST_EVENT_KEY
  })

  await inngest.send({
    name: 'app/cms_intelligence.run',
    data: { triggered_by: 'manual_cms_seed' }
  })

  console.log('CMS intelligence triggered successfully')
}

main().catch(console.error)
