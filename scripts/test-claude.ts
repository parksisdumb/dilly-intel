import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import Anthropic from '@anthropic-ai/sdk'

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Reply with only the word CONFIRMED' }],
  })

  const content = msg.content[0]
  if (content.type === 'text') {
    console.log('Claude response:', content.text)
  } else {
    console.log('Unexpected response type:', content.type)
  }
}

main()
