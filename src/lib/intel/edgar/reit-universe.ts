import { createAdminClient } from '@/lib/supabase/admin'
import { secFetch } from './sec-client'
import type { ReitEntity } from './types'

const REIT_SIC_CODES = new Set([
  '6798', '6552', '6512', '6726', '6500', '6510', '6513', '6531',
])

function zeroPadCik(cik: string | number): string {
  return String(cik).padStart(10, '0')
}

export async function getReitUniverse(): Promise<ReitEntity[]> {
  const db = createAdminClient()

  // Check cache: REITs updated in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: cached } = await db
    .from('intel_entities')
    .select('cik, ticker, name')
    .eq('entity_type', 'reit')
    .eq('enabled', true)
    .not('cik', 'is', null)
    .gte('updated_at', thirtyDaysAgo)

  if (cached && cached.length > 0) {
    return cached.map(r => ({
      cik: zeroPadCik(r.cik),
      ticker: r.ticker || '',
      name: r.name,
    }))
  }

  // Fetch fresh from SEC
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

  // Build candidates from all rows
  const candidates: { cik: string; ticker: string; name: string; exchange: string }[] = []
  for (const row of tickerData.data) {
    candidates.push({
      cik: zeroPadCik(row[cikIdx]),
      ticker: String(row[tickerIdx] || ''),
      name: String(row[nameIdx] || ''),
      exchange: String(row[exchangeIdx] || ''),
    })
  }

  // Batch SIC lookups: groups of 20, 500ms between groups
  const validReits: ReitEntity[] = []
  const GROUP_SIZE = 20

  for (let i = 0; i < candidates.length; i += GROUP_SIZE) {
    const group = candidates.slice(i, i + GROUP_SIZE)

    const results = await Promise.all(
      group.map(async (c) => {
        try {
          const subRes = await secFetch(
            `https://data.sec.gov/submissions/CIK${c.cik}.json`
          )
          if (!subRes.ok) return null
          const sub: { sic?: string } = await subRes.json()
          if (sub.sic && REIT_SIC_CODES.has(sub.sic)) {
            return { ...c, sic: sub.sic }
          }
          return null
        } catch {
          return null
        }
      })
    )

    const valid = results.filter(
      (r): r is { cik: string; ticker: string; name: string; exchange: string; sic: string } =>
        r !== null
    )

    // Upsert valid REITs
    for (const reit of valid) {
      const { error } = await db
        .from('intel_entities')
        .upsert(
          {
            cik: reit.cik,
            name: reit.name,
            ticker: reit.ticker,
            entity_type: 'reit',
            sic: reit.sic,
            exchange: reit.exchange,
            enabled: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'cik' }
        )

      if (!error) {
        validReits.push({ cik: reit.cik, ticker: reit.ticker, name: reit.name })
      }
    }

    // 500ms delay between groups
    if (i + GROUP_SIZE < candidates.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  return validReits
}
