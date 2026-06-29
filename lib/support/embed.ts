import 'server-only'
import OpenAI from 'openai'

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set')
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMS  = 1536

export async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').trim(),
    dimensions: EMBEDDING_DIMS,
  })
  return res.data[0]!.embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.replace(/\n+/g, ' ').trim()),
    dimensions: EMBEDDING_DIMS,
  })
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}
