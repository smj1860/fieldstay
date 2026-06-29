import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { embedText }           from './embed'

/**
 * Phase 2 retrieval — real embedding similarity search.
 * Embeds the query using text-embedding-3-small, then runs cosine similarity
 * search against support_kb_chunks via the match_kb_chunks RPC function.
 *
 * Falls back to recency-ordered chunks if embedding fails, so the bot
 * still responds (with degraded relevance) if OpenAI is temporarily unavailable.
 */
export async function retrieveContext(query: string): Promise<string[]> {
  const supabase = createServiceClient()

  try {
    const embedding = await embedText(query)

    const { data, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: embedding as unknown as string,  // pgvector accepts serialized array
      match_count:     5,
      min_similarity:  0.3,
    })

    if (error) {
      console.error('[support/retrieve] rpc error:', error)
      return await fallbackRetrieve(supabase)
    }

    if (!data || data.length === 0) {
      // No matches above threshold — fall back to recency so the prompt
      // has something rather than nothing
      return await fallbackRetrieve(supabase)
    }

    return (data as Array<{ content: string }>).map((row) => row.content)
  } catch (err) {
    console.error('[support/retrieve] embedding failed, using fallback:', err)
    return await fallbackRetrieve(supabase)
  }
}

async function fallbackRetrieve(
  supabase: ReturnType<typeof createServiceClient>
): Promise<string[]> {
  const { data } = await supabase
    .from('support_kb_chunks')
    .select('content')
    .order('created_at', { ascending: false })
    .limit(5)
  return (data ?? []).map((row) => row.content as string)
}
