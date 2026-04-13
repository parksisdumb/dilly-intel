import Anthropic from '@anthropic-ai/sdk'
import { secFetch } from './sec-client'
import type { EntityExtraction } from './types'

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SYSTEM_PROMPT = `You are extracting entity intelligence from a publicly traded REIT's 10-K SEC filing.
Extract the following and return ONLY valid JSON, no markdown, no explanation.
Return this exact structure:
{
  "portfolio_type": "type_a" | "type_b" | "unknown",
  "sector": "industrial" | "retail" | "multifamily" | "office" | "healthcare" | "self_storage" | "diversified" | "unknown",
  "hq_address": string | null,
  "hq_city": string | null,
  "hq_state": string | null,
  "hq_zip": string | null,
  "hq_phone": string | null,
  "ir_website": string | null,
  "operating_markets": [{"city": string|null, "state": string|null, "region": string|null, "property_count": number|null, "sq_footage": number|null, "property_type": string}],
  "key_contacts": [{"name": string, "title": string}],
  "total_properties": number | null,
  "total_sq_footage": number | null,
  "portfolio_summary": string | null
}

portfolio_type rules:
- type_a = filing lists individual property addresses with street numbers
- type_b = filing lists markets, regions, or cities without specific addresses
- unknown = cannot determine

operating_markets: extract every market, city, or geographic area mentioned as an operating location. Max 50 entries.
key_contacts: CEO, CFO, COO, President, CIO, Head of Real Estate — max 10 entries.
portfolio_summary: one sentence describing what this REIT owns and where. Max 200 chars.`

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
      model: 'claude-sonnet-4-5-20250514',
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

    const parsed = JSON.parse(content.text) as EntityExtraction
    return parsed
  } catch {
    return null
  }
}
