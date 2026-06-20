import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * TEMPORARY — Phase 1 placeholder retrieval.
 * Returns the seeded placeholder chunks regardless of the query.
 * Phase 2 replaces this with real embedding similarity search once
 * support_kb_chunks.embedding is populated by the ingestion pipeline.
 */
export async function retrieveContext(_query: string): Promise<string[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('support_kb_chunks')
    .select('content')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('[support/retrieve] failed to fetch kb chunks', error)
    return []
  }

  return (data ?? []).map((row) => row.content as string)
}
