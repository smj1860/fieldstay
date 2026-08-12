/**
 * Seeds the support knowledge base with the FieldStay help docs.
 *
 * Usage:
 *   npx tsx scripts/seed-support-kb.ts
 *   npx tsx scripts/seed-support-kb.ts --dry-run
 *
 * Reads markdown files from docs/support/, chunks them by heading sections,
 * generates embeddings via OpenAI text-embedding-3-small, and upserts into
 * support_kb_chunks. Safe to re-run — deletes existing non-placeholder chunks
 * before inserting so re-runs stay idempotent.
 */

import { readFileSync, readdirSync } from 'fs'
import { join }                      from 'path'
import { createClient }              from '@supabase/supabase-js'
import OpenAI                        from 'openai'

const DRY_RUN = process.argv.includes('--dry-run')

interface Chunk {
  title:   string
  content: string
  source:  string
}

function chunkMarkdown(markdown: string, filename: string): Chunk[] {
  const chunks: Chunk[] = []
  const lines  = markdown.split('\n')
  const docTitle = lines.find(l => l.startsWith('# '))?.replace('# ', '').trim() ?? filename

  let currentSection = docTitle
  let currentLines: string[] = []

  function flush() {
    const text = currentLines.join('\n').trim()
    if (text.length > 50) {
      chunks.push({
        title:   currentSection,
        content: `${currentSection}\n\n${text}`,
        source:  filename,
      })
    }
  }

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      flush()
      currentSection = line.replace(/^#+\s/, '').trim()
      currentLines   = []
    } else {
      currentLines.push(line)
    }
  }
  flush()

  return chunks
}

async function embedBatch(client: OpenAI, texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({
    model:      'text-embedding-3-small',
    input:      texts.map(t => t.replace(/\n+/g, ' ').trim()),
    dimensions: 1536,
  })
  return res.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)

  const docsDir = join(process.cwd(), 'docs', 'support')
  const files   = readdirSync(docsDir).filter(f => f.endsWith('.md')).sort()

  console.log(`Found ${files.length} help doc(s): ${files.join(', ')}`)

  const allChunks: Chunk[] = []
  for (const file of files) {
    const content = readFileSync(join(docsDir, file), 'utf-8')
    const chunks  = chunkMarkdown(content, file)
    console.log(`  ${file}: ${chunks.length} chunks`)
    allChunks.push(...chunks)
  }

  console.log(`Total chunks to embed: ${allChunks.length}`)

  if (DRY_RUN) {
    console.log('\nDRY RUN — chunks that would be inserted:')
    allChunks.forEach((c, i) => {
      console.log(`  [${i + 1}] ${c.title} (${c.content.length} chars, source: ${c.source})`)
    })
    return
  }

  // Constructed AFTER the dry-run return, not before it. The OpenAI client
  // throws on a missing key at construction, so building it up front made
  // --dry-run require a key it never spends — which defeats the point of
  // having a parse-and-chunk check that can run before the destructive delete.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exit(1)
  }

  // Refuse the E2E project — the mirror image of check-type-drift.mjs's refusal
  // to run against production, and needed for the same reason. CI's
  // NEXT_PUBLIC_SUPABASE_URL secret IS the E2E project, so a re-seed job that
  // reuses the ambient CI secrets would rewrite the E2E project's
  // support_kb_chunks and leave production Finn on whatever it was last
  // seeded with — succeeding loudly while changing nothing a customer sees.
  const E2E_PROJECT_REF = 'syhthijeqlnltufdawyb'
  if (url.includes(E2E_PROJECT_REF)) {
    console.error(
      'Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the E2E project. ' +
      'The support KB is read by production Finn — seed the PRODUCTION project. ' +
      'Set NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY to production values.'
    )
    process.exit(1)
  }

  const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)

  // Remove existing non-placeholder chunks before re-seeding
  const { error: deleteErr } = await supabase
    .from('support_kb_chunks')
    .delete()
    .neq('source', 'placeholder')

  if (deleteErr) {
    console.error('Failed to clear existing chunks:', deleteErr)
    process.exit(1)
  }
  console.log('Cleared existing help-doc chunks')

  // Embed in batches of 20
  const BATCH = 20
  const rows: Array<{ title: string; content: string; source: string; embedding: number[] }> = []

  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch  = allChunks.slice(i, i + BATCH)
    const texts  = batch.map(c => c.content)
    console.log(`Embedding batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(allChunks.length / BATCH)}...`)
    const embeddings = await embedBatch(openai, texts)
    batch.forEach((chunk, j) => {
      rows.push({ ...chunk, embedding: embeddings[j]! })
    })
  }

  const { error: insertErr } = await supabase
    .from('support_kb_chunks')
    .insert(rows)

  if (insertErr) {
    console.error('Failed to insert chunks:', insertErr)
    process.exit(1)
  }

  console.log(`\nDone — inserted ${rows.length} chunks into support_kb_chunks`)
  console.log('The support bot will now use real semantic search for retrieval.')
}

main().catch(err => {
  console.error('Seed script failed:', err)
  process.exit(1)
})
