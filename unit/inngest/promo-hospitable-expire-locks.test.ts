import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { expireHospitablePriceLocks } from '@/lib/inngest/functions/promo-hospitable-expire-locks'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// FINDING-4: the hospitable_launch_promo migration is deliberately held
// back until an explicit launch go-ahead (applying it starts the 90-day
// tier-2 clock), but this cron is registered and running daily regardless
// — confirmed live, erroring on every scheduled run with PGRST205 ("Could
// not find the table 'public.hospitable_launch_promo' in the schema
// cache"), verified empirically against the real project rather than
// guessed. These tests prove that specific code now no-ops quietly
// instead of throwing and burning Inngest retries, while any other error
// still throws.

function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain = {
    update: vi.fn(() => chain),
    eq:     vi.fn(() => chain),
    lt:     vi.fn(() => chain),
    select: vi.fn(async () => result),
  }
  return { from: vi.fn(() => chain) }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('expireHospitablePriceLocks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('expires due price locks and logs the affected orgs', async () => {
    const supabase = makeSupabase({
      data:  [{ org_id: 'org_1', price_lock_sequence: 42 }],
      error: null,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(expireHospitablePriceLocks, {
      event: {}, step: makeStep(), logger,
    })

    expect(result).toEqual({ expiredCount: 1 })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('org=org_1 seq=42'))
  })

  it('is a no-op when nothing is due', async () => {
    const supabase = makeSupabase({ data: [], error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(expireHospitablePriceLocks, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ expiredCount: 0 })
  })

  it('skips quietly (no throw) when the table is not yet migrated (PGRST205)', async () => {
    const supabase = makeSupabase({
      data:  null,
      error: { code: 'PGRST205', message: "Could not find the table 'public.hospitable_launch_promo' in the schema cache" },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(expireHospitablePriceLocks, {
      event: {}, step: makeStep(), logger,
    })

    expect(result).toEqual({ skipped: true, reason: 'not_yet_migrated' })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not yet migrated'))
  })

  it('still throws on any other error code', async () => {
    const supabase = makeSupabase({ data: null, error: { code: '08006', message: 'connection reset' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(expireHospitablePriceLocks, { event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() } }),
    ).rejects.toThrow('Failed to expire due Hospitable price locks: connection reset')
  })
})
