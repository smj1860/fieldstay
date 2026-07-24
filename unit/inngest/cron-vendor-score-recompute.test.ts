import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { vendorScoreRecompute } from '@/lib/inngest/functions/cron/vendor-score-recompute'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

function makeSupabase(rpcResult: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async (_fn: string) => rpcResult)
  return { rpc }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const logger = { info: vi.fn(), error: vi.fn() }

describe('vendorScoreRecompute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls the recompute_vendor_scores RPC and returns the number of vendors updated', async () => {
    const supabase = makeSupabase({ data: 12, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorScoreRecompute, { event: {}, step: makeStep(), logger })

    expect(result).toEqual({ updated: 12 })
    expect(supabase.rpc).toHaveBeenCalledWith('recompute_vendor_scores')
  })

  it('is a no-op result (updated: 0) when no vendor rating data has changed', async () => {
    const supabase = makeSupabase({ data: 0, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorScoreRecompute, { event: {}, step: makeStep(), logger })

    expect(result).toEqual({ updated: 0 })
  })

  it('throws when the recompute_vendor_scores RPC errors', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'permission denied for function' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(vendorScoreRecompute, { event: {}, step: makeStep(), logger }),
    ).rejects.toThrow(/recompute_vendor_scores failed/)
  })
})
