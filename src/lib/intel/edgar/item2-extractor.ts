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
  if (fenced) return fenced[1].trim()
  // Try to find raw JSON object
  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1)
  }
  return text
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

    // Extract Item 1 (Business) section
    const item1Match = text.match(/item\s+1\.?\s*(?:business)/i)
    const item1Start = item1Match ? (item1Match.index ?? 0) : 0
    const item1Text = text.slice(item1Start, item1Start + 8000)

    // Extract Item 2 (Properties) section
    const item2Match = text.match(/item\s+2\.?\s*(?:properties)/i)
    const item3Match = text.match(/item\s+3/i)
    let item2Text = ''
    if (item2Match) {
      const start = item2Match.index ?? 0
      const end = item3Match && item3Match.index && item3Match.index > start
        ? Math.min(item3Match.index, start + 6000)
        : start + 6000
      item2Text = text.slice(start, end)
    }

    const combined = (item1Text + '\n\n' + item2Text).slice(0, 14000)

    if (combined.trim().length < 200) return null

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
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
