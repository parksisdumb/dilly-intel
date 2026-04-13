import Anthropic from '@anthropic-ai/sdk'
import { secFetch } from './sec-client'

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function extractSubsidiaries(
  exhibit21Url: string | null,
  anthropic: Anthropic
): Promise<string[]> {
  if (!exhibit21Url) return []

  try {
    const res = await secFetch(exhibit21Url)
    if (!res.ok) return []

    const html = await res.text()
    const text = stripHtml(html).slice(0, 8000)

    if (text.trim().length < 50) return []

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 2000,
      system: 'Extract all subsidiary and entity names from this SEC Exhibit 21 (List of Subsidiaries). Return ONLY a JSON array of strings — the legal entity names. No markdown.',
      messages: [
        {
          role: 'user',
          content: text,
        },
      ],
    })

    const content = msg.content[0]
    if (content.type !== 'text') return []

    const parsed = JSON.parse(content.text) as string[]
    if (!Array.isArray(parsed)) return []

    // Deduplicate and cap at 200
    return [...new Set(parsed)].slice(0, 200)
  } catch {
    return []
  }
}
