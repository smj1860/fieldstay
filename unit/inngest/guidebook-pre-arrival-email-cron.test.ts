import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  sendGuestPreArrivalEmail: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })),
}))

import {
  guidebookPreArrivalEmailCron,
  guidebookPreArrivalEmailOrg,
} from '@/lib/inngest/functions/guidebook-pre-arrival-email-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { sendGuestPreArrivalEmail } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check. `bookings` is queried once for the
// initial fetch and then once more per booking sent (the mark-sent update),
// so a fixed per-table response isn't enough — order matters.
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
    // This read paginates via fetchAllRows(), which drains .order().range().
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return {
    run: vi.fn((_name: string, cb: () => unknown) => cb()),
    // Variadic to stay assignable to StepStub in ./test-helpers; the
    // dispatcher test reads the event array back off `.mock.calls`.
    sendEvent: vi.fn(async (..._args: unknown[]) => undefined),
  }
}

const makeLogger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })

const bookingRow = (overrides: Record<string, unknown> = {}) => ({
  id:               'bk_1',
  org_id:           'org_1',
  property_id:      'prop_1',
  guest_email:      'guest@example.com',
  guest_name:       'Alex Guest',
  checkin_date:     '2026-07-23',
  guidebook_token:  'tok_abc123',
  status:           'confirmed',
  ...overrides,
})

describe('guidebookPreArrivalEmailCron — dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // The dispatcher must fan out ONE event per org and send no email itself.
  // The previous shape ran one step.run per booking across every tenant in a
  // single invocation, which blows Inngest's 1000-step ceiling and Vercel's
  // 300s cap at roughly 65 tenants — silently, since the run reports success
  // for the bookings it did reach.
  it('dispatches one event per eligible org and sends nothing itself', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [{ org_id: 'org_1' }, { org_id: 'org_2' }, { org_id: 'org_1' }], error: null },
      ],
      guidebook_configurations: [
        { data: [{ org_id: 'org_1' }, { org_id: 'org_2' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookPreArrivalEmailCron, {
      event: {}, step, logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2, checkin_date: '2026-07-23' })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()

    const events = step.sendEvent.mock.calls[0][1] as unknown[]
    expect(events).toHaveLength(2)   // deduped: org_1 appeared twice
    expect(events).toEqual(expect.arrayContaining([
      { name: 'org/guidebook_pre_arrival.requested', data: { org_id: 'org_1', checkin_date: '2026-07-23' } },
      { name: 'org/guidebook_pre_arrival.requested', data: { org_id: 'org_2', checkin_date: '2026-07-23' } },
    ]))
  })

  it('is a no-op when no bookings check in tomorrow', async () => {
    const supabase = makeSupabase({ bookings: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookPreArrivalEmailCron, {
      event: {}, step, logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, checkin_date: '2026-07-23' })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
  })

  it('excludes an org whose guidebook is not active — never dispatches it', async () => {
    const supabase = makeSupabase({
      bookings: [{ data: [{ org_id: 'org_inactive' }], error: null }],
      guidebook_configurations: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookPreArrivalEmailCron, {
      event: {}, step, logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, checkin_date: '2026-07-23' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('guidebookPreArrivalEmailOrg — per-org handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const event = { data: { org_id: 'org_1', checkin_date: '2026-07-23' } }

  it('sends the pre-arrival email and marks the booking sent', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [bookingRow()], error: null },  // fetch-org-bookings
        { data: null, error: null },            // mark-sent update
      ],
      properties: [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailOrg, {
      event, step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', sent: 1, eligible: 1 })
    expect(sendGuestPreArrivalEmail).toHaveBeenCalledWith({
      toEmail:      'guest@example.com',
      guestName:    'Alex Guest',
      propertyName: 'Lake House',
      optInUrl:     expect.stringContaining('/g/b/tok_abc123/opt-in'),
      guidebookUrl: expect.stringContaining('/g/b/tok_abc123'),
      // Opts the guest-facing send into demo-org suppression — the roadshow
      // seed uses @example.com addresses that must never be mailed for real.
      orgId:        'org_1',
    })

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ guidebook_pre_arrival_email_sent_at: expect.any(String) })
  })

  // Service-role client: RLS is not a backstop, so every read and write here
  // has to carry the org filter explicitly.
  it('scopes both the booking read and the mark-sent write to the event org', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [bookingRow()], error: null },
        { data: null, error: null },
      ],
      properties: [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(guidebookPreArrivalEmailOrg, {
      event, step: makeStep(), logger: makeLogger(),
    })

    const orgScoped = supabase.calls.filter(
      (c) => c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === 'org_1',
    )
    expect(orgScoped.some((c) => c.table === 'bookings')).toBe(true)
    expect(orgScoped.some((c) => c.table === 'properties')).toBe(true)
  })

  it('is a no-op when the org has no eligible bookings left', async () => {
    const supabase = makeSupabase({ bookings: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailOrg, {
      event, step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', sent: 0 })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
  })

  it('skips a booking whose property could not be found, without crashing the run', async () => {
    const supabase = makeSupabase({
      bookings:   [{ data: [bookingRow()], error: null }],
      properties: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailOrg, {
      event, step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', sent: 0, eligible: 1 })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
  })
})
