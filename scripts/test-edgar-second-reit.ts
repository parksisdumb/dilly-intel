import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getFilingUrls } from '../src/lib/intel/edgar/filing-fetcher'
import { extractEntityIntelligence } from '../src/lib/intel/edgar/item2-extractor'
import { extractSubsidiaries } from '../src/lib/intel/edgar/exhibit21-parser'
import Anthropic from '@anthropic-ai/sdk'

const CIK = '0000049600' // EastGroup Properties

async function main() {
  console.log('=== EastGroup Properties (CIK: 0000049600, ticker: EGP) ===')
  console.log()

  // Get filing URLs
  console.log('Fetching filing URLs...')
  const filing = await getFilingUrls(CIK, 'EastGroup Properties')
  console.log(`10-K URL: ${filing.documentUrl || 'none'}`)
  console.log(`Exhibit 21 URL: ${filing.exhibit21Url || 'none'}`)
  console.log(`Filing date: ${filing.filingDate || 'none'}`)
  console.log()

  if (!filing.documentUrl) {
    console.log('No 10-K URL — cannot proceed.')
    return
  }

  // Extract entity intelligence
  console.log('Extracting entity intelligence (this may take 30-60s)...')
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const extraction = await extractEntityIntelligence(filing.documentUrl, 'EastGroup Properties, Inc.', anthropic)

  if (!extraction) {
    console.log('Extraction returned null.')
    return
  }

  console.log(JSON.stringify(extraction, null, 2))
  console.log()

  // Subsidiaries
  if (filing.exhibit21Url) {
    console.log('=== Subsidiary Extraction ===')
    console.log('Extracting subsidiaries...')
    const subs = await extractSubsidiaries(filing.exhibit21Url, anthropic)
    console.log(`Total subsidiaries: ${subs.length}`)
    console.log('First 5:', subs.slice(0, 5))
  } else {
    console.log('No Exhibit 21 URL — skipping subsidiary extraction.')
  }

  console.log()
  console.log('=== EASTGROUP TEST COMPLETE ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
