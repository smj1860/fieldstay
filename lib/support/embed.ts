import 'server-only'
import OpenAI from 'openai'

// Constructed lazily, not at module load — see lib/support/anthropic-client.ts
// for why: this file gets pulled into Next.js's page-data-collection pass for
// any route that transitively imports it, and eagerly throwing/instantiating
// here crashes `next build` outright whenever OPENAI_API_KEY isn't present.
let client: OpenAI | null = null

function getOpenAIClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set')
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return client
}

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMS  = 1536

export async function embedText(text: string): Promise<number[]> {
  const res = await getOpenAIClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').trim(),
    dimensions: EMBEDDING_DIMS,
  })
  return res.data[0]!.embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await getOpenAIClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.replace(/\n+/g, ' ').trim()),
    dimensions: EMBEDDING_DIMS,
  })
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}
