import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { embedText }           from './embed'

import { reportError } from '@/lib/observability/report-error'
/**
 * Phase 2 retrieval — real embedding similarity search.
 * Embeds the query using text-embedding-3-small, then runs cosine similarity
 * search against support_kb_chunks via the match_kb_chunks RPC function.
 *
 * Falls back to recency-ordered chunks if embedding fails, so the bot
 * still responds (with degraded relevance) if OpenAI is temporarily unavailable.
 */
export async function retrieveContext(query: string): Promise<string[]> {
  const supabase = createServiceClient({ system: 'lib/support/retrieve' })

  try {
    const embedding = await embedText(query)

    const { data, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: embedding as unknown as string,  // pgvector accepts serialized array
      match_count:     5,
      min_similarity:  0.3,
    })

    if (error) {
      console.error('[support/retrieve] rpc error:', error)
      reportError(error, { site: 'lib.support.retrieve.matchKbChunks' })
      return []
    }

    // No match above the similarity threshold means the KB genuinely does not
    // cover this question. Returning nothing is the honest answer — see the
    // note on the removed recency fallback below.
    if (!data || data.length === 0) return []

    return (data as Array<{ content: string }>).map((row) => row.content)
  } catch (err) {
    console.error('[support/retrieve] embedding failed:', err)
    reportError(err, { site: 'lib.support.retrieve.retrieveContext' })
    return []
  }
}

/*
 * THERE IS DELIBERATELY NO RECENCY FALLBACK.
 *
 * This previously answered an embedding failure, an RPC error, or a
 * below-threshold query by returning the 5 most recent support_kb_chunks rows.
 * That is worse than returning nothing, for a reason specific to how the KB is
 * written: scripts/seed-support-kb.ts DELETES every non-placeholder chunk and
 * re-inserts the whole set, so created_at ordering is not "the newest help
 * content" — it is whichever of the ~299 chunks happened to land in the final
 * insert batch. Arbitrary.
 *
 * The failure mode that produces is the bad one. Finn receives five unrelated
 * help topics presented as relevant context and answers from them fluently and
 * confidently, which reads to a PM exactly like a real answer. An empty context
 * makes it say it does not know, which is true and which a PM can act on.
 *
 * Every path here now reports to Sentry as well, so a silent degradation shows
 * up as an incident rather than as a run of oddly unhelpful support replies.
 */
