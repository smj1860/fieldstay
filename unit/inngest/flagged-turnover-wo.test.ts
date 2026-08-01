import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/push/client', () => ({
  sendPushToCrewMember: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { flaggedTurnoverToWO } from '@/lib/inngest/functions/flagged-turnover-wo'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { sendPushToCrewMember } from '@/lib/push/client'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — needed here because
// `work_orders` is queried twice with two different intended outcomes
// (the idempotency existence-check, then the insert-and-select), which a
// single fixed canned response per table can't represent.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    // fetchTurnoverCreatedEvents drains via fetchAllRows(), which calls
    // .order().range(). The chain is already thenable, so returning it
    // resolves one page and terminates the pagination loop.
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  // getPmMembers() resolves each member's email through the Admin API.
  // Emails are irrelevant to what these tests assert, but a member whose
  // email can't be resolved is dropped, so every id must resolve.
  const auth = {
    admin: {
      getUserById: vi.fn((id: string) =>
        Promise.resolve({ data: { user: { id, email: `${id}@example.com` } }, error: null })),
    },
  }

  return { from, calls, auth }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const FLAG_EVENT = {
  data: {
    turnover_id: 'to_1',
    property_id: 'prop_1',
    org_id:      'org_1',
    flag_notes:  'Found a broken window latch during checkout inspection that needs prompt attention',
    flagged_by:  'crew_1',
  },
}

describe('flaggedTurnoverToWO', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a draft WO from the flagged turnover and pushes to managers who have a subscription', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: null },                                     // idempotency check: none exists yet
        { data: { id: 'wo_1', wo_number: 'WO-1001' } },      // insert(...).select('id, wo_number').single()
      ],
      properties: [{ data: { name: 'The Lakehouse' } }],
      organization_members: [
        { data: [{ org_id: 'org_1', user_id: 'u1', role: 'owner' }, { org_id: 'org_1', user_id: 'u2', role: 'manager' }] },
      ],
      push_subscriptions: [
        { data: [{ endpoint: 'https://push.example/u1', p256dh: 'p1', auth: 'a1' }] }, // u1 has a subscription
        { data: [] },                                                                   // u2 has none
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(flaggedTurnoverToWO, {
      event: FLAG_EVENT,
      step:  runAllStep(),
    })

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect(insertCall?.args[0]).toEqual(
      expect.objectContaining({
        org_id:             'org_1',
        property_id:        'prop_1',
        source_turnover_id: 'to_1',
        title:              'Issue Flagged During Turnover — The Lakehouse',
        description:        FLAG_EVENT.data.flag_notes,
        priority:           'high',
        status:             'pending',
        source:             'crew_flag',
      }),
    )

    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'work_order.created',
        targetType: 'work_order',
        targetId:   'wo_1',
        metadata:   { source: 'crew_flag', turnover_id: 'to_1' },
      }),
    )

    // u1 has a subscription and gets pushed, u2 does not.
    expect(sendPushToCrewMember).toHaveBeenCalledTimes(1)
    expect(sendPushToCrewMember).toHaveBeenCalledWith(
      [{ endpoint: 'https://push.example/u1', p256dh: 'p1', auth: 'a1' }],
      expect.objectContaining({
        title: 'Flagged Issue → Draft WO Created',
        body:  FLAG_EVENT.data.flag_notes.slice(0, 80),
        url:   '/maintenance',
      }),
    )

    expect(result).toEqual({ work_order_id: 'wo_1', wo_number: 'WO-1001' })
  })

  it('only notifies invite-accepted PMs — the member lookup goes through getPmMembers', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: null },
        { data: { id: 'wo_3', wo_number: 'WO-1003' } },
      ],
      properties: [{ data: { name: 'The Lakehouse' } }],
      organization_members: [{ data: [] }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(flaggedTurnoverToWO, { event: FLAG_EVENT, step: runAllStep() })

    // Regression guard: this step used to query organization_members inline
    // without the invite_accepted_at filter, so members with a pending
    // invite were treated as notifiable PMs.
    const memberCalls = supabase.calls.filter((c) => c.table === 'organization_members')
    expect(memberCalls.some((c) => c.method === 'not' && c.args[0] === 'invite_accepted_at')).toBe(true)
    expect(memberCalls.some((c) => c.method === 'in' && c.args[0] === 'role')).toBe(true)
  })

  it('logs and reports a failed push instead of swallowing it, and still completes the run', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: null },
        { data: { id: 'wo_4', wo_number: 'WO-1004' } },
      ],
      properties: [{ data: { name: 'The Lakehouse' } }],
      organization_members: [{ data: [{ org_id: 'org_1', user_id: 'u1', role: 'admin' }] }],
      push_subscriptions: [
        { data: [{ endpoint: 'https://push.example/u1', p256dh: 'p1', auth: 'a1' }] },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(sendPushToCrewMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('push endpoint gone'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await invokeHandler(flaggedTurnoverToWO, { event: FLAG_EVENT, step: runAllStep() })

    expect(consoleError).toHaveBeenCalledWith(
      '[flagged-turnover-wo] push notification failed',
      expect.objectContaining({ orgId: 'org_1', error: 'push endpoint gone' }),
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.flagged-turnover-wo.notify-manager' }),
    )
    expect(result).toEqual({ work_order_id: 'wo_4', wo_number: 'WO-1004' })
    consoleError.mockRestore()
  })

  it('is idempotent: a duplicate flag event for the same turnover does not create a second WO', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { id: 'wo_existing', wo_number: 'WO-0999' } }, // already exists for this turnover + source
      ],
      organization_members: [{ data: [] }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(flaggedTurnoverToWO, {
      event: FLAG_EVENT,
      step:  runAllStep(),
    })

    // Only the existence-check + the manager lookup — no property lookup,
    // no insert, because the early `if (existing) return existing` short-
    // circuits the rest of the create-draft-wo step.
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'properties')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(sendPushToCrewMember).not.toHaveBeenCalled()
    expect(result).toEqual({ work_order_id: 'wo_existing', wo_number: 'WO-0999' })
  })

  it('falls back to a generic property label when the property lookup finds nothing', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: null },
        { data: { id: 'wo_2', wo_number: 'WO-1002' } },
      ],
      properties: [{ data: null }],
      organization_members: [{ data: [] }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(flaggedTurnoverToWO, { event: FLAG_EVENT, step: runAllStep() })

    const insertCall = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'insert')
    expect((insertCall?.args[0] as { title: string }).title).toBe('Issue Flagged During Turnover — Property')
  })
})
