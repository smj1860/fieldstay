import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPmNotification } from '@/lib/inngest/helpers'

// FINDING-1: confirmed live 2026-07-25 (92 occurrences, 9 users) —
// "insert or update on table notifications violates foreign key constraint
// notifications_org_id_fkey". Root cause confirmed via pg_constraint: no
// application code path deletes organizations rows directly, but
// work_orders/notifications both cascade ON DELETE from organizations(id),
// so a background Inngest step already holding a stale org_id in its event
// payload from before an out-of-band org deletion hits this FK on insert.
// There's no org left to notify — these tests prove that case is skipped
// (logged, not thrown) while every other error path is unchanged.

function makeSupabase(insertResult: { error: unknown }) {
  const insert = vi.fn(async () => insertResult)
  const from = vi.fn(() => ({ insert }))
  return { from, insert }
}

const BASE_INPUT = {
  orgId: 'org_1',
  type:  'work_order_complete',
  title: 'Test notification',
  href:  '/maintenance/wo_1',
}

describe('createPmNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('inserts successfully with no error', async () => {
    const supabase = makeSupabase({ error: null })

    await createPmNotification(supabase as never, BASE_INPUT)

    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: 'org_1', type: 'work_order_complete' }),
    )
  })

  it('swallows a 23505 (dedupe_key unique violation) without throwing', async () => {
    const supabase = makeSupabase({ error: { code: '23505', message: 'duplicate key' } })

    await expect(createPmNotification(supabase as never, BASE_INPUT)).resolves.toBeUndefined()
  })

  it('swallows a 23503 (org_id FK violation — org no longer exists) with a warning, not a throw', async () => {
    const supabase = makeSupabase({
      error: { code: '23503', message: 'insert or update on table "notifications" violates foreign key constraint "notifications_org_id_fkey"' },
    })

    await expect(createPmNotification(supabase as never, BASE_INPUT)).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('org_1'),
      expect.objectContaining({ type: 'work_order_complete' }),
    )
  })

  it('still throws on any other error code', async () => {
    const supabase = makeSupabase({ error: { code: '23502', message: 'null value in column "title"' } })

    await expect(createPmNotification(supabase as never, BASE_INPUT)).rejects.toThrow(
      'Failed to create notification: null value in column "title"',
    )
  })
})
