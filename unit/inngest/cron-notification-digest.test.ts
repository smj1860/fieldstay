import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))

import { notificationDigest } from '@/lib/inngest/functions/cron/notification-digest'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// This function does NOT use notification_digest_state/diffDigestSnapshot —
// it rolls up raw counts (work orders created, RepuGuard drafts generated)
// per org and writes one dedupe_key-guarded notification per org per
// category per day via createPmNotification, which is mocked here (same
// convention as work-order-dispatch.test.ts) rather than simulated at the
// `notifications` table level.
function makeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.gte    = () => chain
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: null, error: null }).then(resolve, reject)
    return chain
  })
  return { from }
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
    expect(createPmNotification).not.toHaveBeenCalled()
  })

  it('writes one digest notification per org per category with the correct counts and dedupe keys', async () => {
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
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notificationDigest, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ notifications_created: 2 })

    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId:     'org_1',
        type:      'work_order_created_digest',
        title:     '2 work orders created today',
        href:      '/maintenance',
        severity:  'blue',
        dedupeKey: 'wo-created-digest-org_1-2026-07-22',
      }),
    )
    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId:     'org_2',
        type:      'repuguard_digest',
        title:     '3 review drafts ready',
        href:      '/reviews',
        severity:  'blue',
        dedupeKey: 'repuguard-digest-org_2-2026-07-22',
      }),
    )
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
    expect(createPmNotification).not.toHaveBeenCalled()
  })
})
