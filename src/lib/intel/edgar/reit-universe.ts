import { createAdminClient } from '@/lib/supabase/admin'
import { secFetch } from './sec-client'
import type { ReitEntity } from './types'

const NAREIT_URL = 'https://www.reit.com/data-research/reit-indexes/reits-by-ticker-symbol'
const RAA_URL = 'https://www.reitsacrossamerica.com/reits-owning-property/The%20United%20States'
const CACHE_MIN = 150

// Tickers that don't appear in SEC company_tickers_exchange.json
const TICKER_CIK_OVERRIDES: Record<string, { cik: string; name: string }> = {
  'PLYM': { cik: '0001515816', name: 'Plymouth Industrial REIT, Inc.' },
  'MPW':  { cik: '0001287865', name: 'Medical Properties Trust, Inc.' },
  'ALEX': { cik: '0001545654', name: 'Alexander & Baldwin, Inc.' },
}

const REITS_ACROSS_AMERICA_FALLBACK = [
  "Acadia Realty Trust", "ACRES Commercial Realty Corp.",
  "AGNC Investment Corp.", "Agree Realty Corporation", "Aimco",
  "Alexander & Baldwin, Inc.", "Alexander's, Inc.",
  "Alexandria Real Estate Equities, Inc.", "Alpine Income Property Trust",
  "American Assets Trust", "American Healthcare REIT, Inc.",
  "American Strategic Investment Co.", "Americold Realty Trust", "AMH",
  "Angel Oak Mortgage, Inc.", "Apartment Income REIT Corp.",
  "Apollo Commercial RE Finance, Inc.", "Apple Hospitality REIT, Inc.",
  "Arbor Realty Trust, Inc.", "Armada Hoffler Properties, Inc.",
  "ARMOUR Residential REIT", "Ashford Hospitality Trust",
  "AvalonBay Communities, Inc.", "Blackstone Mortgage Trust, Inc.",
  "Blackstone Real Estate Advisors", "Blackstone Real Estate Income Trust, Inc.",
  "Bluerock Homes Trust, Inc.", "Braemar Hotels & Resorts, Inc.",
  "Brandywine Realty Trust", "BrightSpire Capital, Inc.",
  "Brixmor Property Group Inc.", "Broadstone Net Lease, Inc.",
  "Burroughs & Chapin Company, Inc.", "BXP", "Camden Property Trust",
  "CareTrust REIT, Inc.", "CBL Properties", "Centerspace",
  "Chatham Lodging Trust", "CIM Real Estate Finance Trust, Inc.",
  "City Office REIT", "Claros Mortgage Trust, Inc.", "Clipper Realty Inc.",
  "CNL Healthcare Properties Inc.", "Community Healthcare Trust",
  "COPT Defense Properties", "CorEnergy Infrastructure Trust",
  "Cousins Properties", "Creative Media & Community Trust",
  "Crown Castle Inc.", "CTO Realty Growth, Inc.", "CubeSmart",
  "DiamondRock Hospitality Company", "Digital Realty",
  "Diversified Healthcare Trust", "Dynex Capital, Inc.",
  "Easterly Government Properties", "EastGroup Properties, Inc.",
  "Elme Communities", "Empire State Realty Trust", "EPR Properties",
  "Equinix, Inc.", "Equity Commonwealth", "Equity LifeStyle Properties, Inc.",
  "Equity Residential", "Essential Properties Realty Trust, Inc.",
  "Essex Property Trust, Inc.", "Extra Space Storage, Inc.",
  "Farmland Partners Inc.", "Federal Realty Investment Trust",
  "First Industrial Realty Trust, Inc.",
  "First Real Estate Investment Trust of New Jersey, Inc.",
  "FirstKey Homes, LLC", "Flagship Healthcare Trust, Inc.",
  "Four Corners Property Trust", "Four Springs Capital Trust",
  "Franklin BSP Realty Trust Inc.", "Franklin Street Properties Corp",
  "G City", "Gaming and Leisure Properties, Inc.", "GCP REIT IV",
  "Getty Realty Corp.", "Gladstone Commercial Corporation",
  "Gladstone Land Corporation", "Global Medical REIT", "Global Net Lease",
  "Global Self Storage, Inc.", "Great Ajax Corp", "GTJ REIT, Inc.",
  "Healthcare Realty Trust", "Healthcare Trust, Inc.",
  "Healthpeak Properties, Inc.", "Highwoods Properties, Inc.",
  "Hines Global Income Trust, Inc.", "Host Hotels & Resorts, Inc.",
  "Howard Hughes Holdings Inc.", "Hudson Pacific Properties, Inc.",
  "Independence Realty Trust", "Industrial Logistics Properties Trust",
  "Inland Real Estate Income Trust, Inc.",
  "InPoint Commercial Real Estate Income, Inc.",
  "InvenTrust Properties Corp.", "Invitation Homes", "IQHQ",
  "Iron Mountain", "J.P. Morgan Real Estate Income Trust, Inc.",
  "JBG SMITH", "JLL Income Property Trust, Inc.",
  "KBS Growth & Income REIT, Inc.", "KBS Real Estate Investment Trust III",
  "Kennedy Wilson", "Kilroy Realty Corporation", "Kimco Realty Corporation",
  "Kite Realty Group Trust", "Ladder Capital Corp",
  "Lamar Advertising Company", "Lineage", "LTC Properties, Inc.",
  "LXP Industrial Trust", "MAA", "Macerich",
  "MCR Hospitality Fund REIT LLC", "Medalist Diversified REIT, Inc.",
  "Medical Properties Trust Inc.", "MFA Financial, Inc.",
  "Modiv Industrial, Inc.", "National Health Investors, Inc.",
  "National Storage Affiliates", "NETSTREIT", "NexPoint Real Estate Finance",
  "NexPoint Residential Trust Inc.", "NNN REIT, Inc.",
  "Office Properties Income Trust", "Omega Healthcare Investors, Inc.",
  "One Liberty Properties, Inc.", "Orion Office REIT Inc.",
  "OUTFRONT Media Inc.", "Paramount Group, Inc.", "Park Hotels & Resorts",
  "Peakstone Realty Trust", "Pebblebrook Hotel Trust",
  "Phillips Edison & Co.", "Piedmont Office Realty Trust, Inc.",
  "Plymouth Industrial REIT, Inc.", "Postal Realty Trust, Inc.",
  "PotlatchDeltic Corp.", "PREIT", "Prologis, Inc.", "Public Storage",
  "Rayonier Inc.", "Ready Capital Corporation", "Realty Income Corporation",
  "Regency Centers Corporation", "RLJ Lodging Trust",
  "Royal Oak Realty Trust", "Ryman Hospitality Properties, Inc.",
  "Sabra Health Care REIT, Inc.", "Sachem Capital Corp.", "Safehold Inc.",
  "Saul Centers, Inc.", "SBA Communications Corporation",
  "Service Properties Trust", "Seven Hills Realty Trust",
  "ShopOne Centers REIT, Inc.", "Sila Realty Trust, Inc.",
  "Silver Star Properties REIT, Inc.", "Simon Property Group, Inc.",
  "SITE Centers Corp.", "SL Green Realty Corp.",
  "SmartStop Self Storage REIT, Inc.", "Sotherly Hotels Inc.",
  "STAG Industrial, Inc.", "Starwood Property Trust, Inc.",
  "Starwood Real Estate Income Trust", "STORE Capital Corporation",
  "Strawberry Fields REIT", "Sun Communities, Inc.",
  "Sunstone Hotel Investors, Inc.", "Tanger Inc.", "Terravet REIT Inc.",
  "Terreno Realty Corporation", "The Community Development Trust",
  "TPG RE Finance Trust, Inc.", "UDR, Inc.", "UMH Properties, Inc.",
  "Uniti Group Inc.", "Urban Edge Properties", "Ventas, Inc.",
  "Veris Residential, Inc.", "VICI Properties, Inc.",
  "Vinebrook Homes Trust, Inc.", "Vornado Realty Trust", "W. P. Carey Inc.",
  "Watson Land Company", "Welltower Inc.", "Weyerhaeuser",
  "Whitestone REIT", "Xenia Hotels & Resorts, Inc.",
]

function zeroPadCik(cik: string | number): string {
  return String(cik).padStart(10, '0')
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s*(inc\.?|corp\.?|corporation|llc|l\.?p\.?|trust|company|co\.?|ltd\.?|properties|realty|reit)$/gi, '')
    .replace(/[.,'"]/g, '')
    .trim()
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  return false
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

async function fetchReitsAcrossAmerica(): Promise<string[]> {
  try {
    const res = await fetch(RAA_URL)
    if (!res.ok) return REITS_ACROSS_AMERICA_FALLBACK

    const html = await res.text()
    // Parse <li> items from the main list
    const names: string[] = []
    const liPattern = /<li[^>]*>\s*([^<]+?)\s*<\/li>/g
    let match: RegExpExecArray | null
    while ((match = liPattern.exec(html)) !== null) {
      const name = match[1].trim()
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
      if (name.length > 2 && !name.startsWith('<')) names.push(name)
    }

    return names.length >= 100 ? names : REITS_ACROSS_AMERICA_FALLBACK
  } catch {
    return REITS_ACROSS_AMERICA_FALLBACK
  }
}

export async function getReitUniverse(forceRefresh = false): Promise<ReitEntity[]> {
  const db = createAdminClient()

  // Check cache
  if (!forceRefresh) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = await db
      .from('intel_entities')
      .select('cik, ticker, name')
      .eq('entity_type', 'reit')
      .eq('enabled', true)
      .gte('updated_at', thirtyDaysAgo)

    if (cached && cached.length >= CACHE_MIN) {
      return cached.map(r => ({
        cik: r.cik ? zeroPadCik(r.cik) : null,
        ticker: r.ticker || null,
        name: r.name,
        is_traded: !!(r.ticker),
      }))
    }
  }

  // Clean up non-REITs from prior runs
  await db.from('intel_entities').delete().eq('ticker', 'CBRE').eq('source_detail', 'edgar_10k')

  // ── Source 1: NAREIT ticker list ──
  const nareitRes = await fetch(NAREIT_URL)
  if (!nareitRes.ok) throw new Error(`NAREIT fetch failed: ${nareitRes.status}`)
  const nareitList = parseNareitHtml(await nareitRes.text())

  // Build SEC ticker → CIK lookup (one request)
  const tickerRes = await secFetch('https://www.sec.gov/files/company_tickers_exchange.json')
  if (!tickerRes.ok) throw new Error(`SEC tickers fetch failed: ${tickerRes.status}`)
  const tickerData: { fields: string[]; data: (string | number)[][] } = await tickerRes.json()
  const fields = tickerData.fields
  const cikIdx = fields.indexOf('cik')
  const tickerIdx = fields.indexOf('ticker')
  const exchangeIdx = fields.indexOf('exchange')

  const secLookup = new Map<string, { cik: string; exchange: string }>()
  for (const row of tickerData.data) {
    const t = String(row[tickerIdx] || '').toUpperCase()
    secLookup.set(t, {
      cik: zeroPadCik(row[cikIdx]),
      exchange: String(row[exchangeIdx] || ''),
    })
  }

  // Match NAREIT tickers to CIKs
  const universe: ReitEntity[] = []
  const matchedNames = new Set<string>() // normalized names already in universe

  for (const reit of nareitList) {
    const ticker = reit.ticker.toUpperCase()
    const sec = secLookup.get(ticker)
    const override = TICKER_CIK_OVERRIDES[ticker]

    const cik = sec?.cik ?? override?.cik ?? null
    if (!cik) continue

    await db.from('intel_entities').upsert({
      cik,
      name: reit.name,
      ticker,
      entity_type: 'reit',
      exchange: sec?.exchange ?? '',
      enabled: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'cik' })

    universe.push({ cik, ticker, name: reit.name, is_traded: true })
    matchedNames.add(normalizeName(reit.name))
  }

  // ── Source 2: REITs Across America ──
  const raaNames = await fetchReitsAcrossAmerica()

  for (const raaName of raaNames) {
    // Skip if already matched from NAREIT
    if (matchedNames.has(normalizeName(raaName))) continue
    if (universe.some(r => namesMatch(r.name, raaName))) continue

    // Try SEC EDGAR search for a CIK
    let cik: string | null = null
    try {
      const encoded = encodeURIComponent(`"${raaName}"`)
      const searchRes = await secFetch(
        `https://efts.sec.gov/LATEST/search-index?q=${encoded}&forms=10-K&dateRange=custom&startdt=2023-01-01&enddt=2026-12-31`
      )
      if (searchRes.ok) {
        const searchData: { hits?: { hits?: { _source?: { ciks?: string[] } }[] } } = await searchRes.json()
        const firstCik = searchData.hits?.hits?.[0]?._source?.ciks?.[0]
        if (firstCik) cik = zeroPadCik(firstCik)
      }
    } catch {
      // SEC search failed — continue without CIK
    }

    // Upsert — even without CIK, record the entity as a known REIT
    if (cik) {
      await db.from('intel_entities').upsert({
        cik,
        name: raaName,
        entity_type: 'reit',
        source_detail: 'reitsacrossamerica',
        enabled: true,
        needs_website_scrape: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'cik' })
    } else {
      // No CIK — insert without conflict key (may create duplicates, check first)
      const { data: existing } = await db
        .from('intel_entities')
        .select('id')
        .eq('name', raaName)
        .eq('entity_type', 'reit')
        .limit(1)

      if (!existing || existing.length === 0) {
        await db.from('intel_entities').insert({
          name: raaName,
          entity_type: 'reit',
          source_detail: 'reitsacrossamerica',
          enabled: true,
          needs_website_scrape: true,
          updated_at: new Date().toISOString(),
        })
      }
    }

    universe.push({ cik, ticker: null, name: raaName, is_traded: false })
    matchedNames.add(normalizeName(raaName))
  }

  return universe
}
