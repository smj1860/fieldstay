import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/observability/metrics', () => ({
  incrementCounter: vi.fn(),
}))

import { handleWorkOrderCrewCompleted } from '@/lib/inngest/functions/work-order-crew-completed'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { incrementCounter } from '@/lib/observability/metrics'
import { invokeHandler } from './test-helpers'

// Fixed canned response per table — every table here is queried exactly
// once per test (work_orders + crew_members in a Promise.all, then
// properties), so no call-ordering is needed.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single      = vi.fn(() => Promise.resolve(result))
    // Same result: the property lookup now uses maybeSingle().
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return { from }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('handleWorkOrderCrewCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits the completion metric and notifies the PM with the crew/WO/property names', async () => {
    const supabase = makeSupabase({
      work_orders:  { data: { id: 'wo_1', wo_number: 'WO-42', title: 'Fix the sink', property_id: 'prop_1' }, error: null },
      crew_members: { data: { id: 'c1', name: 'Maria' }, error: null },
      properties:   { data: { name: 'The Lakehouse', address: '1 Lake Dr' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCrewCompleted, {
      event: {
        data: {
          workOrderId:  'wo_1',
          orgId:        'org_1',
          crewMemberId: 'c1',
          completedAt:  '2026-07-20T10:00:00Z',
          notes:        'All done, no issues',
        },
      },
      step: runAllStep(),
    })

    expect(incrementCounter).toHaveBeenCalledWith(
      'fieldstay_work_orders_completed_by_crew_total',
      { org_id: 'org_1' },
    )
    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'work_order_complete',
      title:     '✓ Work Complete — WO-42 · The Lakehouse',
      subtitle:  'Maria marked "Fix the sink" complete — All done, no issues',
      href:      '/maintenance/wo_1',
      severity:  'green',
      dedupeKey: 'crew-wo-complete-wo_1',
    })
    expect(result).toEqual({ notified: true })
  })

  it('falls back to generic labels when the WO, crew, and property lookups all return nothing', async () => {
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCrewCompleted, {
      event: {
        data: {
          workOrderId:  'wo_2',
          orgId:        'org_1',
          crewMemberId: 'c2',
          completedAt:  '2026-07-20T10:00:00Z',
          notes:        null,
        },
      },
      step: runAllStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
      title:    '✓ Work Complete — WO · the property',
      subtitle: 'A crew member marked "a work order" complete',
    }))
  })

  // Neither .single() checked its error, so an RLS regression or a timeout was
  // indistinguishable from PGRST116 — both leave `data` null. Every field in
  // the notification then falls back, so a failed read shipped the PM the
  // content-free notification asserted in the test above instead of retrying.
  // PGRST116 stays a legitimate not-found (that test still passes); a real
  // error throws.
  it.each([
    ['work_orders',  { message: 'permission denied for table work_orders', code: '42501' }],
    ['crew_members', { message: 'canceling statement due to statement timeout', code: '57014' }],
  ])('throws instead of sending a content-free notification when the %s read really fails', async (table, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({
      work_orders:  { data: { id: 'wo_1', wo_number: 'WO-42', title: 'Fix the sink', property_id: 'prop_1' }, error: null },
      crew_members: { data: { id: 'c1', name: 'Maria' }, error: null },
      [table]:      { data: null, error },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleWorkOrderCrewCompleted, {
        event: { data: { workOrderId: 'wo_1', orgId: 'org_1', crewMemberId: 'c1', completedAt: '2026-07-20T10:00:00Z', notes: null } },
        step:  runAllStep(),
      }),
    ).rejects.toThrow()
    expect(createPmNotification).not.toHaveBeenCalled()
  })

  // `.eq('id', woRes.data?.property_id ?? '')` sent an empty string where a
  // uuid was required: Postgres rejects it with 22P02, so a missing WO
  // produced a spurious parse error in Sentry in place of the real cause.
  it('does not query properties at all when the work order has no property_id', async () => {
    const supabase = makeSupabase({
      work_orders:  { data: { id: 'wo_1', wo_number: 'WO-42', title: 'Fix the sink', property_id: null }, error: null },
      crew_members: { data: { id: 'c1', name: 'Maria' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCrewCompleted, {
      event: { data: { workOrderId: 'wo_1', orgId: 'org_1', crewMemberId: 'c1', completedAt: '2026-07-20T10:00:00Z', notes: null } },
      step:  runAllStep(),
    })

    expect(supabase.from).not.toHaveBeenCalledWith('properties')
    expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
      title: '✓ Work Complete — WO-42 · the property',
    }))
  })
})
