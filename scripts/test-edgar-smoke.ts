import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { secFetch } from '../src/lib/intel/edgar/sec-client'
import { getFilingUrls } from '../src/lib/intel/edgar/filing-fetcher'
import { extractEntityIntelligence } from '../src/lib/intel/edgar/item2-extractor'
import { extractSubsidiaries } from '../src/lib/intel/edgar/exhibit21-parser'
import Anthropic from '@anthropic-ai/sdk'

const CIK = '0001045609' // Prologis

async function main() {
  // ── 1. SEC tickers endpoint ──
  console.log('=== 1. SEC Tickers Endpoint ===')
  const tickerRes = await secFetch('https://www.sec.gov/files/company_tickers_exchange.json')
  const tickerData: { fields: string[]; data: (string | number)[][] } = await tickerRes.json()
  console.log(`Status: ${tickerRes.status}`)
  console.log(`Total rows: ${tickerData.data.length}`)
  console.log()

  // ── 2. Prologis submissions ──
  console.log('=== 2. Prologis Submissions ===')
  const subRes = await secFetch(`https://data.sec.gov/submissions/CIK${CIK}.json`)
  const subData = await subRes.json() as {
    name: string
    sic: string
    filings: { recent: { form: string[]; filingDate: string[] } }
  }
  console.log(`Company: ${subData.name}`)
  console.log(`SIC: ${subData.sic}`)

  const forms = subData.filings.recent.form
  const dates = subData.filings.recent.filingDate
  let first10KDate: string | null = null
  let hasEx21 = false

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === '10-K' && !first10KDate) first10KDate = dates[i]
    if (forms[i] === 'EX-21' || forms[i] === 'EX-21.1') hasEx21 = true
  }
  console.log(`Most recent 10-K filing date: ${first10KDate}`)
  console.log(`EX-21 exhibit exists: ${hasEx21 ? 'yes' : 'no'}`)
  console.log()

  // ── 3. Filing fetcher ──
  console.log('=== 3. Filing Fetcher ===')
  const filing = await getFilingUrls(CIK, 'Prologis')
  console.log(`10-K URL: ${filing.documentUrl || 'none'}`)
  console.log(`Exhibit 21 URL: ${filing.exhibit21Url || 'none'}`)
  console.log(`Filing date: ${filing.filingDate || 'none'}`)
  console.log()

  if (!filing.documentUrl) {
    console.log('No 10-K URL — cannot proceed with extraction.')
    return
  }

  // ── 4. Entity intelligence extraction ──
  console.log('=== 4. Entity Intelligence Extraction ===')
  console.log('Calling Claude to extract from 10-K (this may take 30-60s)...')
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const extraction = await extractEntityIntelligence(filing.documentUrl, 'Prologis, Inc.', anthropic)

  if (!extraction) {
    console.log('Extraction returned null — check model access or document parsing.')
    return
  }

  console.log(JSON.stringify(extraction, null, 2))
  console.log()

  // ── 5. Subsidiary extraction ──
  if (filing.exhibit21Url) {
    console.log('=== 5. Subsidiary Extraction ===')
    console.log('Calling Claude to extract subsidiaries...')
    const subs = await extractSubsidiaries(filing.exhibit21Url, anthropic)
    console.log(`Total subsidiaries: ${subs.length}`)
    console.log('First 5:', subs.slice(0, 5))
  } else {
    console.log('=== 5. Subsidiary Extraction ===')
    console.log('No Exhibit 21 URL — skipping.')
  }

  console.log()
  console.log('=== SMOKE TEST COMPLETE ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
