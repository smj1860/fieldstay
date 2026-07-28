import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { webhookDedupCleanup } from '@/lib/inngest/functions/cron/webhook-dedup-cleanup'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// H-5: this cron replaces the webhook route's old probabilistic (5%-of-
// requests) cleanup with a real daily sweep. Coverage: the RPC is invoked
// correctly, success is logged/returned, and a DB-level error surfaces as a
// thrown Error so Inngest retries the step rather than silently dropping it.

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(async () => rpcResult)
  return { rpc }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('webhookDedupCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to cleanup_webhook_dedup() and reports success', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(webhookDedupCleanup, {
      event:  {},
      step:   makeStep(),
      logger,
    })

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('cleanup_webhook_dedup')
    expect(result).toEqual({ ok: true })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('TTL sweep complete'))
  })

  it('throws when the RPC call itself errors, so Inngest retries the step', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(webhookDedupCleanup, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('cleanup_webhook_dedup failed: connection reset')
  })
})
