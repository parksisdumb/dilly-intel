import Anthropic from '@anthropic-ai/sdk'
import { secFetch } from './sec-client'
import type { EntityExtraction } from './types'

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractJson(text: string): string {
  // Strip markdown fences if Claude wraps the response
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  let json = fenced ? fenced[1].trim() : text
  // Find raw JSON object boundaries
  const braceStart = json.indexOf('{')
  const braceEnd = json.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    json = json.slice(braceStart, braceEnd + 1)
  }
  // Fix trailing commas before ] or } (common Claude output issue)
  json = json.replace(/,\s*([}\]])/g, '$1')
  return json
}

function findFirst(text: string, patterns: RegExp[]): number | null {
  let earliest: number | null = null
  for (const p of patterns) {
    const m = text.match(p)
    if (m && m.index != null) {
      if (earliest === null || m.index < earliest) {
        earliest = m.index
      }
    }
  }
  return earliest
}

const SYSTEM_PROMPT = `You are extracting entity-level portfolio intelligence from a publicly traded REIT's 10-K SEC filing. Do NOT extract individual property addresses. Extract market-level and entity-level data only.

Return ONLY valid JSON matching this exact structure. No markdown, no explanation, no code fences.

{
  "portfolio_type": "type_a" | "type_b" | "unknown",
  "sector": "industrial" | "retail" | "multifamily" | "office" | "healthcare" | "self_storage" | "diversified" | "unknown",
  "hq_address": string | null,
  "hq_city": string | null,
  "hq_state": string | null,
  "hq_zip": string | null,
  "hq_phone": string | null,
  "ir_website": string | null,
  "operating_markets": [
    {
      "city": string | null,
      "state": string | null,
      "region": string | null,
      "property_count": number | null,
      "sq_footage": number | null,
      "sq_footage_consolidated": number | null,
      "sq_footage_omm": number | null,
      "gross_book_value_millions": number | null,
      "development_acres": number | null,
      "development_est_sqft": number | null,
      "property_type": string
    }
  ],
  "investment_vehicles": [
    {
      "name": string,
      "vehicle_type": "consolidated_venture" | "unconsolidated_venture" | "fund" | "other",
      "sq_footage": number | null,
      "geography": string | null
    }
  ],
  "key_contacts": [{"name": string, "title": string}],
  "total_properties": number | null,
  "total_sq_footage": number | null,
  "portfolio_summary": string | null
}

Rules:
- portfolio_type: type_a = filing lists individual street addresses. type_b = filing lists markets/regions/cities without street addresses.
- operating_markets: extract every market row from the properties table. For US markets extract city name and state abbreviation. For international entries use country as region. If the table shows both consolidated and O&M square footage, populate both sq_footage_consolidated and sq_footage_omm. Use sq_footage as the best single figure (prefer O&M if available). Extract gross_book_value_millions from the Gross Book Value column. Extract development_acres and development_est_sqft from the land and development pipeline table if present. Max 60 entries.
- investment_vehicles: extract all named co-investment ventures and funds from the co-investment ventures table or anywhere else in the filing. These are the legal entity names that hold title to properties in public records — critical for PropTracer and county assessor matching. Examples: "Prologis Targeted U.S. Logistics Fund", "Prologis U.S. Logistics Venture". Max 30 entries.
- key_contacts: CEO, CFO, COO, President, CIO, CRO — max 10 entries.
- portfolio_summary: one sentence, max 200 chars.`

export async function extractEntityIntelligence(
  documentUrl: string,
  reitName: string,
  anthropic: Anthropic
): Promise<EntityExtraction | null> {
  try {
    const res = await secFetch(documentUrl)
    if (!res.ok) return null

    const html = await res.text()
    const text = stripHtml(html)

    // --- Item 1: take first 3000 chars for sector/HQ ---
    const item1Start = findFirst(text, [
      /item\s+1[\.\s]+business/i,
      /item\s+1\b/i,
      /ITEM\s+1/,
    ]) ?? 0
    const item1Head = text.slice(item1Start, item1Start + 3000)

    // --- Item 2: find full section boundaries ---
    const item2Start = findFirst(text, [
      /item\s+2[\.\s]+properties/i,
      /item\s+2\b/i,
      /ITEM\s+2/,
    ])

    // Search for Item 3 only AFTER Item 2
    let item3Start: number | null = null
    if (item2Start != null) {
      const afterItem2 = text.slice(item2Start + 100)
      const item3Offset = findFirst(afterItem2, [
        /item\s+3[\.\s]+legal/i,
        /item\s+3\b/i,
        /ITEM\s+3/,
      ])
      if (item3Offset != null) {
        item3Start = item2Start + 100 + item3Offset
      }
    }

    let item2Head = ''
    let item2Tail = ''

    if (item2Start != null) {
      const item2End = item3Start ?? item2Start + 50000
      const fullItem2 = text.slice(item2Start, item2End)

      // First 4000 chars: narrative overview, HQ, portfolio description
      item2Head = fullItem2.slice(0, 4000)

      // Last 8000 chars: structured tables (market data, co-investment ventures)
      if (fullItem2.length > 8000) {
        item2Tail = fullItem2.slice(fullItem2.length - 8000)
      } else {
        item2Tail = fullItem2
      }
    }

    // --- Co-investment ventures: search whole document ---
    let coInvestSection = ''
    const coInvestMatch = text.match(/co-investment/i)
    if (coInvestMatch && coInvestMatch.index != null) {
      const candidate = text.slice(coInvestMatch.index, coInvestMatch.index + 3000)
      // Only add if not already in item2Tail
      if (!item2Tail.includes(candidate.slice(0, 200))) {
        coInvestSection = candidate
      }
    }

    // --- Combine: Item1 head + Item2 head + Item2 tail + co-invest ---
    const combined = (
      item1Head + '\n\n' + item2Head + '\n\n' + item2Tail + '\n\n' + coInvestSection
    ).slice(0, 18000)

    if (combined.trim().length < 200) return null

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Extract entity intelligence from this ${reitName} 10-K filing:\n\n${combined}`,
        },
      ],
    })

    const content = msg.content[0]
    if (content.type !== 'text') return null

    const parsed = JSON.parse(extractJson(content.text)) as EntityExtraction
    return parsed
  } catch {
    return null
  }
}
