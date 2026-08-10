import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPmNotification, createPmNotifications } from '@/lib/inngest/helpers'

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

// ============================================================================
// createPmNotifications — the batch variant (P3-10).
//
// createPmNotification() stays the right shape for the dominant case: one
// event, one row. This exists for the case it cannot serve — a single event
// that legitimately produces N distinct rows, where looping the single-row API
// means N inserts. notifyOwnerBlockOpportunities() was doing exactly that.
// ============================================================================

function makeBatchSupabase(results: Array<{ error: unknown }> = []) {
  const calls: Array<{ op: 'insert' | 'upsert'; rows: unknown[]; opts?: unknown }> = []
  let i = 0
  const next = () => results[i++] ?? { error: null }

  const insert = vi.fn(async (rows: unknown[]) => { calls.push({ op: 'insert', rows }); return next() })
  const upsert = vi.fn(async (rows: unknown[], opts: unknown) => { calls.push({ op: 'upsert', rows, opts }); return next() })
  const from   = vi.fn(() => ({ insert, upsert }))
  return { from, insert, upsert, calls }
}

const withKey = (n: number) => ({ ...BASE_INPUT, title: `n${n}`, dedupeKey: `k${n}` })

describe('createPmNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('writes many rows in ONE statement instead of one insert per row', async () => {
    const supabase = makeBatchSupabase()

    await createPmNotifications(supabase as never, [withKey(1), withKey(2), withKey(3)])

    expect(supabase.calls).toHaveLength(1)
    expect(supabase.calls[0].rows).toHaveLength(3)
  })

  it('issues nothing at all for an empty batch', async () => {
    const supabase = makeBatchSupabase()
    await createPmNotifications(supabase as never, [])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('uses ignoreDuplicates so ONE collision cannot drop the whole batch', async () => {
    // The single-row version catches 23505 because one insert either collides
    // or does not. In a batch, a colliding row aborts the entire statement —
    // so a single already-delivered notification would silently take every
    // other row with it. That is the failure this option prevents.
    const supabase = makeBatchSupabase()

    await createPmNotifications(supabase as never, [withKey(1), withKey(2)])

    expect(supabase.calls[0].op).toBe('upsert')
    expect(supabase.calls[0].opts).toEqual({ onConflict: 'dedupe_key', ignoreDuplicates: true })
  })

  it('separates keyless rows — the partial index cannot arbitrate them', async () => {
    // notifications' unique index covers `dedupe_key IS NOT NULL`, so an
    // ON CONFLICT naming that column cannot resolve rows the index does not
    // contain. Those go through a plain insert.
    const supabase = makeBatchSupabase()

    await createPmNotifications(supabase as never, [
      withKey(1),
      { ...BASE_INPUT, title: 'no key' },
    ])

    const upserts = supabase.calls.filter((c) => c.op === 'upsert')
    const inserts = supabase.calls.filter((c) => c.op === 'insert')
    expect(upserts).toHaveLength(1)
    expect(inserts).toHaveLength(1)
    expect(upserts[0].rows).toHaveLength(1)
    expect(inserts[0].rows).toHaveLength(1)
  })

  it('skips a batch for a deleted org (23503) instead of retrying forever', async () => {
    const supabase = makeBatchSupabase([{ error: { code: '23503', message: 'fk violation' } }])

    await expect(createPmNotifications(supabase as never, [withKey(1)])).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
  })

  it('throws on any other error rather than losing the batch silently', async () => {
    const supabase = makeBatchSupabase([{ error: { code: '42P01', message: 'undefined_table' } }])

    await expect(createPmNotifications(supabase as never, [withKey(1)]))
      .rejects.toThrow(/undefined_table/)
  })

  it('chunks past 500 rows rather than building one unbounded request body', async () => {
    const supabase = makeBatchSupabase()

    await createPmNotifications(
      supabase as never,
      Array.from({ length: 1200 }, (_, i) => withKey(i)),
    )

    expect(supabase.calls.map((c) => c.rows.length)).toEqual([500, 500, 200])
  })
})
