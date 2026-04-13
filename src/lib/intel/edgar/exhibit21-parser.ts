import Anthropic from '@anthropic-ai/sdk'
import { secFetch } from './sec-client'

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const bracketStart = text.indexOf('[')
  const bracketEnd = text.lastIndexOf(']')
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    return text.slice(bracketStart, bracketEnd + 1)
  }
  return text
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
      model: 'claude-sonnet-4-6',
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

    const parsed = JSON.parse(extractJsonArray(content.text)) as string[]
    if (!Array.isArray(parsed)) return []

    // Deduplicate and cap at 200
    return [...new Set(parsed)].slice(0, 200)
  } catch {
    return []
  }
}
