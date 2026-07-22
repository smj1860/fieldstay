import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { auditRetentionCron } from '@/lib/inngest/functions/cron/audit-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// This cron is a thin wrapper around a single Postgres RPC
// (purge_expired_audit_events()) — the 7yr/3yr retention-window cutoff math
// itself lives entirely inside that SQL function, not in this TS handler,
// so there is no boundary date computation here to fake-timer test (unlike
// guest-pii-retention / comms-retention, which compute their own cutoffs in
// JS). Coverage here is: the RPC is invoked correctly, its result is
// returned/logged as-is, and a DB-level error surfaces as a thrown Error so
// Inngest retries the step.

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(async () => rpcResult)
  return { rpc }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('auditRetentionCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to purge_expired_audit_events() and returns its counts', async () => {
    const supabase = makeSupabase({
      data:  { financial_deleted: 4, operational_deleted: 19, run_at: '2026-07-22T03:00:00.000Z' },
      error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(auditRetentionCron, {
      event: {},
      step:  makeStep(),
      logger,
    })

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('purge_expired_audit_events')
    expect(result).toEqual({ financial_deleted: 4, operational_deleted: 19, run_at: '2026-07-22T03:00:00.000Z' })
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('financial deleted: 4') as unknown as string,
    )
  })

  it('is a no-op when nothing has aged past either retention window', async () => {
    const supabase = makeSupabase({
      data:  { financial_deleted: 0, operational_deleted: 0, run_at: '2026-07-22T03:00:00.000Z' },
      error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(auditRetentionCron, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ financial_deleted: 0, operational_deleted: 0, run_at: '2026-07-22T03:00:00.000Z' })
  })

  it('throws when the RPC call itself errors, so Inngest retries the step', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(auditRetentionCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('purge_expired_audit_events failed: connection reset')
  })
})
