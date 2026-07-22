import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { guidebookStayExtensionCron } from '@/lib/inngest/functions/guidebook-stay-extension-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check. `bookings` is queried twice per
// gap candidate (the target-checkout select, then the next-booking select),
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
    chain.gt     = (...a: unknown[]) => record('gt', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const configRow = (overrides: Record<string, unknown> = {}) => ({
  org_id:                        'org_1',
  is_active:                     true,
  extension_messaging_enabled:   true,
  extension_gap_threshold_days:  2,
  extension_discount_pct:        15,
  extension_contact_method:      'email',
  extension_ownerrez_url:        null,
  extension_message_days_before: 3,
  ...overrides,
})

const bookingRow = (overrides: Record<string, unknown> = {}) => ({
  id:            'bk_1',
  org_id:        'org_1',
  property_id:   'prop_1',
  checkout_date: '2026-07-25', // today (2026-07-22) + 3 days
  ...overrides,
})

describe('guidebookStayExtensionCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T15:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a stay-extension request and dispatches the notify event for a qualifying gap, including the opted-in guest phone', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
      bookings: [
        { data: [bookingRow()], error: null },                              // target-checkout select
        { data: { id: 'bk_next', checkin_date: '2026-07-29' }, error: null }, // next-booking select — 4 day gap
      ],
      stay_extension_requests: [
        { data: null, error: null },              // no existing request
        { data: { id: 'req_1' }, error: null },    // insert
      ],
      guidebook_guest_sms_optins: [
        { data: { phone_e164: '+15551234567', is_active: true }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 1, date: '2026-07-22' })
    expect(sendSpy).toHaveBeenCalledWith({
      name: 'guidebook/stay.extension.request',
      data: {
        requestId:          'req_1',
        orgId:              'org_1',
        bookingId:          'bk_1',
        propertyId:         'prop_1',
        gapDays:            4,
        discountPct:        15,
        contactMethod:      'email',
        ownerRezUrl:        null,
        guestPhoneE164:     '+15551234567',
        nextBookingCheckin: '2026-07-29',
      },
    })

    const insertCall = supabase.calls.find((c) => c.table === 'stay_extension_requests' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ org_id: 'org_1', booking_id: 'bk_1', gap_days: 4, status: 'pending' })
  })

  it('is a no-op when no orgs have extension messaging enabled', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0, date: '2026-07-22' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('idempotency: does not create a second request or re-notify when UNIQUE(booking_id) already has a row for this booking', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
      bookings: [
        { data: [bookingRow()], error: null },
      ],
      stay_extension_requests: [
        { data: { id: 'req_existing' }, error: null }, // already handled
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0, date: '2026-07-22' })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'stay_extension_requests' && c.method === 'insert')).toBe(false)
    // Never even looks for a next booking once it already knows this one is handled —
    // only one `.from('bookings')` call (the target-checkout select), not two.
    expect(supabase.from.mock.calls.filter((c) => c[0] === 'bookings').length).toBe(1)
  })

  it('skips a gap that is smaller than the org\'s configured threshold', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow({ extension_gap_threshold_days: 10 })], error: null }],
      bookings: [
        { data: [bookingRow()], error: null },
        { data: { id: 'bk_next', checkin_date: '2026-07-27' }, error: null }, // only a 2-day gap
      ],
      stay_extension_requests: [
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0, date: '2026-07-22' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('does not offer an extension when the calendar is open after checkout (no future booking at the property)', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
      bookings: [
        { data: [bookingRow()], error: null },
        { data: null, error: null }, // no next booking
      ],
      stay_extension_requests: [
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    const result = await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0, date: '2026-07-22' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('never sends the guest phone number in the event when the guest is not (or no longer) opted in to SMS', async () => {
    const supabase = makeSupabase({
      guidebook_configurations: [{ data: [configRow()], error: null }],
      bookings: [
        { data: [bookingRow()], error: null },
        { data: { id: 'bk_next', checkin_date: '2026-07-29' }, error: null },
      ],
      stay_extension_requests: [
        { data: null, error: null },
        { data: { id: 'req_1' }, error: null },
      ],
      guidebook_guest_sms_optins: [
        { data: { phone_e164: '+15551234567', is_active: false }, error: null }, // opted out
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] })

    await invokeHandler(guidebookStayExtensionCron, {
      event: {}, step: makeStep(), logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ guestPhoneE164: null }) })
    )
  })
})
