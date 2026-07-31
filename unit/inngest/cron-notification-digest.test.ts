import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { notificationDigest } from '@/lib/inngest/functions/cron/notification-digest'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// This function does NOT use notification_digest_state/diffDigestSnapshot —
// it rolls up raw counts (work orders created, RepuGuard drafts generated)
// per org and writes one dedupe_key-guarded notification row per org per
// category per day.
//
// It no longer calls createPmNotification once per org: that was one insert
// round-trip per tenant inside a single step (150 sequential inserts at 150
// orgs). The write is now a chunked dedupe pre-check + ONE batch insert into
// `notifications`, so the double seeds that table as a queue: the pre-check
// select first, then the insert().select('id') result.
function makeSupabase(responses: Record<string, TableSpec>) {
  return createSupabaseDouble(responses)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('notificationDigest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('is a no-op when there are no work orders or review drafts in the last 24h', async () => {
    const supabase = makeSupabase({
      work_orders:      { data: [], error: null },
      review_responses: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationDigest, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ notifications_created: 0 })
    // Nothing to digest means the notifications table is never touched at all.
    expect(supabase.calls.some((c) => c.table === 'notifications')).toBe(false)
  })

  it('writes one digest notification per org per category with the correct counts and dedupe keys, in a single batch insert', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: [
          // Two already-assigned WOs for org_1 → counted.
          { org_id: 'org_1', vendor_id: 'v1', status: 'assigned' },
          { org_id: 'org_1', vendor_id: 'v1', status: 'in_progress' },
          // Still-unassigned WO — excluded (cron-daily-wrapup names it individually tonight).
          { org_id: 'org_1', vendor_id: null, status: 'pending' },
        ],
        error: null,
      },
      review_responses: {
        data: [
          { org_id: 'org_2' },
          { org_id: 'org_2' },
          { org_id: 'org_2' },
        ],
        error: null,
      },
      notifications: [
        { data: [], error: null },                              // dedupe pre-check — neither key exists yet
        { data: [{ id: 'n_1' }, { id: 'n_2' }], error: null },  // batch insert
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationDigest, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ notifications_created: 2 })

    // ONE insert carrying every org's row — not one round-trip per org.
    const inserts = supabase.calls.filter((c) => c.table === 'notifications' && c.method === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.args[0]).toEqual([
      expect.objectContaining({
        org_id:     'org_1',
        type:       'work_order_created_digest',
        title:      '2 work orders created today',
        href:       '/maintenance',
        severity:   'blue',
        dedupe_key: 'wo-created-digest-org_1-2026-07-22',
      }),
      expect.objectContaining({
        org_id:     'org_2',
        type:       'repuguard_digest',
        title:      '3 review drafts ready',
        href:       '/reviews',
        severity:   'blue',
        dedupe_key: 'repuguard-digest-org_2-2026-07-22',
      }),
    ])

    // The dedupe pre-check runs before the insert, keyed on the same keys —
    // notifications.dedupe_key is a PARTIAL unique index, which Postgres
    // cannot use as an ON CONFLICT arbiter through PostgREST.
    const precheck = supabase.calls.find((c) => c.table === 'notifications' && c.method === 'in')
    expect(precheck?.args).toEqual([
      'dedupe_key',
      ['wo-created-digest-org_1-2026-07-22', 'repuguard-digest-org_2-2026-07-22'],
    ])
  })

  it('skips a digest whose dedupe key the pre-check already found (cron rerun / retry)', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: [{ org_id: 'org_1', vendor_id: 'v1', status: 'assigned' }],
        error: null,
      },
      review_responses: { data: [], error: null },
      notifications: [
        // Today's key already present — an earlier run of this cron wrote it.
        { data: [{ dedupe_key: 'wo-created-digest-org_1-2026-07-22' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationDigest, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ notifications_created: 0 })
    expect(supabase.calls.some((c) => c.table === 'notifications' && c.method === 'insert')).toBe(false)
  })

  it('excludes a work order still awaiting a vendor from the count, even as the org\'s only WO', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: [
          { org_id: 'org_3', vendor_id: null, status: 'quote_requested' },
        ],
        error: null,
      },
      review_responses: { data: [], error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationDigest, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ notifications_created: 0 })
    expect(supabase.calls.some((c) => c.table === 'notifications')).toBe(false)
  })
})
