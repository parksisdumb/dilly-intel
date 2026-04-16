import { createAdminClient } from '@/lib/supabase/admin'
import { secFetch } from './sec-client'
import type { ReitEntity } from './types'

const NAREIT_URL = 'https://www.reit.com/data-research/reit-indexes/reits-by-ticker-symbol'
const CACHE_MIN = 150

function zeroPadCik(cik: string | number): string {
  return String(cik).padStart(10, '0')
}

function parseNareitHtml(html: string): { ticker: string; name: string }[] {
  const results: { ticker: string; name: string }[] = []

  // Match each table row containing ticker + name cells
  const rowPattern = /<tr[^>]*>\s*<td[^>]*views-field-field-ticker-symbol[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td[^>]*views-field-title[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/td>/g
  let match: RegExpExecArray | null

  while ((match = rowPattern.exec(html)) !== null) {
    const ticker = match[1].trim()
    const name = match[2].trim()
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'")
      .replace(/&quot;/g, '"')
    if (ticker && name) {
      results.push({ ticker, name })
    }
  }

  return results
}

export async function getReitUniverse(forceRefresh = false): Promise<ReitEntity[]> {
  const db = createAdminClient()

  // Check cache: REITs updated in last 30 days
  if (!forceRefresh) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = await db
      .from('intel_entities')
      .select('cik, ticker, name')
      .eq('entity_type', 'reit')
      .eq('enabled', true)
      .not('cik', 'is', null)
      .gte('updated_at', thirtyDaysAgo)

    if (cached && cached.length >= CACHE_MIN) {
      return cached.map(r => ({
        cik: zeroPadCik(r.cik),
        ticker: r.ticker || '',
        name: r.name,
      }))
    }
  }

  // Clean up non-REITs from prior SIC-based runs
  await db
    .from('intel_entities')
    .delete()
    .eq('ticker', 'CBRE')
    .eq('source_detail', 'edgar_10k')

  // Step 1: Fetch authoritative NAREIT ticker list
  const nareitRes = await fetch(NAREIT_URL)
  if (!nareitRes.ok) {
    throw new Error(`NAREIT fetch failed: ${nareitRes.status}`)
  }
  const nareitHtml = await nareitRes.text()
  const nareitList = parseNareitHtml(nareitHtml)

  if (nareitList.length < 100) {
    throw new Error(`NAREIT parse returned only ${nareitList.length} entries — expected 150+`)
  }

  // Step 2: Build ticker → CIK lookup from SEC tickers JSON (one request)
  const tickerRes = await secFetch('https://www.sec.gov/files/company_tickers_exchange.json')
  if (!tickerRes.ok) {
    throw new Error(`SEC tickers fetch failed: ${tickerRes.status}`)
  }
  const tickerData: { fields: string[]; data: (string | number)[][] } = await tickerRes.json()
  const fields = tickerData.fields
  const cikIdx = fields.indexOf('cik')
  const nameIdx = fields.indexOf('name')
  const tickerIdx = fields.indexOf('ticker')
  const exchangeIdx = fields.indexOf('exchange')

  const secLookup = new Map<string, { cik: string; name: string; exchange: string }>()
  for (const row of tickerData.data) {
    const ticker = String(row[tickerIdx] || '').toUpperCase()
    secLookup.set(ticker, {
      cik: zeroPadCik(row[cikIdx]),
      name: String(row[nameIdx] || ''),
      exchange: String(row[exchangeIdx] || ''),
    })
  }

  // Step 3: Match NAREIT tickers to SEC CIKs
  const validReits: ReitEntity[] = []

  for (const reit of nareitList) {
    const sec = secLookup.get(reit.ticker.toUpperCase())
    if (!sec) continue // No SEC filing found — skip

    const { error } = await db
      .from('intel_entities')
      .upsert(
        {
          cik: sec.cik,
          name: reit.name, // Use NAREIT name (cleaner than SEC legal name)
          ticker: reit.ticker.toUpperCase(),
          entity_type: 'reit',
          exchange: sec.exchange,
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cik' }
      )

    if (!error) {
      validReits.push({
        cik: sec.cik,
        ticker: reit.ticker.toUpperCase(),
        name: reit.name,
      })
    }
  }

  return validReits
}
