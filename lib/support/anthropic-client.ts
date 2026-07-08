import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

// Constructed lazily, not at module load — this file gets pulled into
// Next.js's page-data-collection pass for any route that transitively
// imports it, and eagerly throwing/instantiating here crashed `next build`
// outright whenever ANTHROPIC_API_KEY wasn't present in the build
// environment, not just "on first user request" as originally intended.
let client: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return client
}
