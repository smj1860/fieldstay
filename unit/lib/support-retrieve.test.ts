import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/support/embed', () => ({
  embedText: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { embedText } from '@/lib/support/embed'
import { reportError } from '@/lib/observability/report-error'
import { retrieveContext } from '@/lib/support/retrieve'

type Resp = { data?: unknown; error?: unknown }

// Supports both the .rpc(...) call (retrieveContext's happy path) and the
// .from('support_kb_chunks').select().order().limit() fallback path.
function makeSupabase({ rpc, fallback }: { rpc?: Resp; fallback?: Resp } = {}) {
  const rpcFn = vi.fn(() => Promise.resolve(rpc ?? { data: [], error: null }))
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(fallback ?? { data: [], error: null }).then(resolve)
    return chain
  })
  return { rpc: rpcFn, from }
}

describe('retrieveContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns matched chunk contents from the embedding similarity search', async () => {
    const supabase = makeSupabase({
      rpc: { data: [{ content: 'How to add a property' }, { content: 'How to invite crew' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1, 0.2, 0.3])

    const result = await retrieveContext('how do I add a property?')

    expect(result).toEqual(['How to add a property', 'How to invite crew'])
    expect(supabase.rpc).toHaveBeenCalledWith('match_kb_chunks', {
      query_embedding: [0.1, 0.2, 0.3], match_count: 5, min_similarity: 0.3,
    })
  })

  // ==========================================================================
  // THERE IS NO RECENCY FALLBACK, DELIBERATELY.
  //
  // These three cases previously returned the 5 most recent support_kb_chunks
  // rows. That is worse than nothing here: seed-support-kb.ts DELETEs every
  // non-placeholder chunk and re-inserts the whole set, so created_at order is
  // not "newest help content" — it is whichever of ~299 chunks landed in the
  // final insert batch. Arbitrary.
  //
  // The resulting failure is the dangerous kind. Finn receives five unrelated
  // topics labelled as relevant context and answers from them fluently, which
  // reads to a PM exactly like a real answer. Empty context makes it say it
  // does not know — true, and actionable.
  // ==========================================================================

  it('returns nothing when the RPC call errors, rather than unrelated chunks', async () => {
    const supabase = makeSupabase({
      rpc:      { data: null, error: { message: 'rpc failed' } },
      fallback: { data: [{ content: 'Fallback chunk 1' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question')

    expect(result).toEqual([])
    expect(reportError).toHaveBeenCalled()
  })

  it('returns nothing when no chunk clears the similarity threshold', async () => {
    // The KB genuinely does not cover this question. Saying so beats
    // answering from whatever happens to be lying around.
    const supabase = makeSupabase({
      rpc:      { data: [], error: null },
      fallback: { data: [{ content: 'Fallback chunk A' }, { content: 'Fallback chunk B' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question with no good matches')

    expect(result).toEqual([])
  })

  it('returns nothing when embedText throws (e.g. OpenAI outage), and reports it', async () => {
    const supabase = makeSupabase({
      fallback: { data: [{ content: 'Degraded fallback chunk' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockRejectedValue(new Error('OpenAI unavailable'))

    const result = await retrieveContext('a question')

    expect(result).toEqual([])
    expect(supabase.rpc).not.toHaveBeenCalled()
    // A silent degradation must surface as an incident, not as a run of
    // oddly unhelpful support replies.
    expect(reportError).toHaveBeenCalled()
  })

  it('returns an empty array from the fallback when there are no chunks at all', async () => {
    const supabase = makeSupabase({
      rpc:      { data: null, error: { message: 'rpc failed' } },
      fallback: { data: [], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question')

    expect(result).toEqual([])
  })

  it('returns an empty array from the fallback when the fallback query itself returns null data', async () => {
    const supabase = makeSupabase({
      rpc:      { data: null, error: { message: 'rpc failed' } },
      fallback: { data: null, error: { message: 'fallback also failed' } },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question')

    expect(result).toEqual([])
  })
})
