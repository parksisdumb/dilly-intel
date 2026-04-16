import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const NAREIT_URL = 'https://www.reit.com/data-research/reit-indexes/reits-by-ticker-symbol'

function zeroPadCik(cik: string | number): string {
  return String(cik).padStart(10, '0')
}

function parseNareitHtml(html: string): { ticker: string; name: string }[] {
  const results: { ticker: string; name: string }[] = []
  const rowPattern = /<tr[^>]*>\s*<td[^>]*views-field-field-ticker-symbol[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td[^>]*views-field-title[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/td>/g
  let match: RegExpExecArray | null
  while ((match = rowPattern.exec(html)) !== null) {
    const ticker = match[1].trim()
    const name = match[2].trim()
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'")
      .replace(/&quot;/g, '"')
    if (ticker && name) results.push({ ticker, name })
  }
  return results
}

async function main() {
  // Clean up CBRE
  await db.from('intel_entities').delete().eq('ticker', 'CBRE').eq('source_detail', 'edgar_10k')

  // Fetch NAREIT
  console.log('Fetching NAREIT ticker list...')
  const nareitRes = await fetch(NAREIT_URL)
  const nareitHtml = await nareitRes.text()
  const nareitList = parseNareitHtml(nareitHtml)
  console.log('NAREIT tickers parsed:', nareitList.length)

  // Fetch SEC lookup
  console.log('Fetching SEC tickers JSON...')
  const secRes = await fetch('https://www.sec.gov/files/company_tickers_exchange.json', {
    headers: { 'User-Agent': 'DillyIntel/1.0 team@dillyos.com' },
  })
  const secData: { fields: string[]; data: (string | number)[][] } = await secRes.json()
  const fields = secData.fields
  const cikIdx = fields.indexOf('cik')
  const tickerIdx = fields.indexOf('ticker')
  const nameIdx = fields.indexOf('name')
  const exchangeIdx = fields.indexOf('exchange')

  const secLookup = new Map<string, { cik: string; name: string; exchange: string }>()
  for (const row of secData.data) {
    const ticker = String(row[tickerIdx] || '').toUpperCase()
    secLookup.set(ticker, {
      cik: zeroPadCik(row[cikIdx]),
      name: String(row[nameIdx] || ''),
      exchange: String(row[exchangeIdx] || ''),
    })
  }

  // Match
  const matched: { ticker: string; name: string; cik: string }[] = []
  const unmatched: string[] = []
  for (const reit of nareitList) {
    const sec = secLookup.get(reit.ticker.toUpperCase())
    if (sec) {
      matched.push({ ticker: reit.ticker.toUpperCase(), name: reit.name, cik: sec.cik })
    } else {
      unmatched.push(reit.ticker)
    }
  }

  console.log('Matched with SEC CIK:', matched.length)
  console.log('No SEC match (skipped):', unmatched.length, unmatched.length > 0 ? unmatched.join(', ') : '')
  console.log()

  // Upsert
  console.log('Upserting to intel_entities...')
  for (const reit of matched) {
    await db.from('intel_entities').upsert(
      {
        cik: reit.cik,
        name: reit.name,
        ticker: reit.ticker,
        entity_type: 'reit',
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cik' }
    )
  }

  // Verify
  const reits = matched
  console.log()
  console.log('Total:', reits.length)

  const checkIn = ['Prologis', 'Public Storage', 'Simon Property', 'Welltower',
    'Realty Income', 'EastGroup', 'VICI', 'Agree Realty',
    'American Tower', 'Digital Realty']
  const checkOut = ['CBRE', 'Jones Lang', 'Cushman', 'DR Horton', 'Lennar']

  console.log('--- Should be IN ---')
  checkIn.forEach(n => {
    const f = reits.find(r => r.name.toLowerCase().includes(n.toLowerCase()))
    console.log(n + ':', f ? 'FOUND (' + f.ticker + ')' : 'MISSING')
  })
  console.log('--- Should be OUT ---')
  checkOut.forEach(n => {
    const f = reits.find(r => r.name.toLowerCase().includes(n.toLowerCase()))
    console.log(n + ':', f ? 'STILL IN' : 'CORRECTLY EXCLUDED')
  })

  console.log()
  console.log('--- Full list (' + reits.length + ' total) ---')
  reits.forEach(r => console.log(r.ticker.padEnd(8), r.name))
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
