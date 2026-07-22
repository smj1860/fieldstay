import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/support/embed', () => ({
  embedText: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { embedText } from '@/lib/support/embed'
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

  it('falls back to recency-ordered chunks when the RPC call errors', async () => {
    const supabase = makeSupabase({
      rpc:      { data: null, error: { message: 'rpc failed' } },
      fallback: { data: [{ content: 'Fallback chunk 1' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question')

    expect(result).toEqual(['Fallback chunk 1'])
  })

  it('falls back to recency-ordered chunks when the RPC returns zero matches above threshold', async () => {
    const supabase = makeSupabase({
      rpc:      { data: [], error: null },
      fallback: { data: [{ content: 'Fallback chunk A' }, { content: 'Fallback chunk B' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockResolvedValue([0.1])

    const result = await retrieveContext('a question with no good matches')

    expect(result).toEqual(['Fallback chunk A', 'Fallback chunk B'])
  })

  it('falls back to recency-ordered chunks when embedText itself throws (e.g. OpenAI outage)', async () => {
    const supabase = makeSupabase({
      fallback: { data: [{ content: 'Degraded fallback chunk' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(embedText).mockRejectedValue(new Error('OpenAI unavailable'))

    const result = await retrieveContext('a question')

    expect(result).toEqual(['Degraded fallback chunk'])
    expect(supabase.rpc).not.toHaveBeenCalled()
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
