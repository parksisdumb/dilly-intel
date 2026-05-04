import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { Inngest } from 'inngest'

async function main() {
  // Usage: npx tsx scripts/trigger-proptracer-scraper.ts [--test]
  //   --test  run against 5-county subset (Shelby, Davidson, Knox, Hamilton, Pickett)
  //   (none)  run all 95 Tennessee counties
  //
  // This fires `app/proptracer_collect.run`. The collect function will
  // automatically chain to `app/proptracer_enrich.run` when done.
  const isTest = process.argv.includes('--test')

  const inngest = new Inngest({
    id: 'dilly-intel',
    eventKey: process.env.INNGEST_EVENT_KEY,
  })

  await inngest.send({
    name: 'app/proptracer_collect.run',
    data: {
      triggered_by: 'manual',
      counties: isTest ? 'test' : 'all',
    },
  })

  console.log(
    `PropTracer collect triggered (counties=${isTest ? 'test (5)' : 'all (95)'})`
  )
  console.log('Collect will chain to enrich when done.')
}

main().catch(console.error)
