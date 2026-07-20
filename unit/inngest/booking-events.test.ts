import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { handleBookingConfirmed, handleBookingDetected } from '@/lib/inngest/functions/booking-events'
import { createServiceClient } from '@/lib/supabase/server'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — needed because
// handleBookingDetected re-uses `properties`/`bookings`/`owner_transactions`
// across two independent steps with different intents.
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
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(),
  }
}

const IDEMPOTENT_UPSERT_OPTS = { onConflict: 'source_reference_id,source' }

describe('handleBookingConfirmed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers the PMS-reported actual_total_amount over the avg_nightly_rate estimate, and allows it to overwrite an earlier estimate', async () => {
    const supabase = makeSupabase({
      bookings:   [{ data: { checkin_date: '2026-08-01', checkout_date: '2026-08-04', guest_name: 'Sam Guest' }, error: null }],
      properties: [{ data: { avg_nightly_rate: 100 }, error: null }],
      owner_transactions: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleBookingConfirmed, {
      event: { data: { booking_id: 'bk_1', property_id: 'prop_1', org_id: 'org_1', source: 'uplisting', actual_total_amount: 450.5 } },
      step:  makeStep(),
    })

    const upsertCall = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toEqual(expect.objectContaining({
      property_id:          'prop_1',
      org_id:               'org_1',
      source:               'uplisting_booking',
      source_reference_id:  'bk_1',
      transaction_type:     'revenue',
      category:             'booking_revenue',
      amount:               450.5,
      description:          '3 nights — Sam Guest',
      transaction_date:     '2026-08-01',
      visible_to_owner:     true,
    }))
    // A real actual_total_amount must be allowed to correct an earlier
    // estimate — ignoreDuplicates must be false for this post.
    expect(upsertCall?.args[1]).toEqual({ ...IDEMPOTENT_UPSERT_OPTS, ignoreDuplicates: false })
    expect(result).toEqual({ booking_id: 'bk_1' })
  })

  it('falls back to nights * avg_nightly_rate and posts as a droppable estimate when no actual total is reported', async () => {
    const supabase = makeSupabase({
      bookings:   [{ data: { checkin_date: '2026-08-01', checkout_date: '2026-08-03', guest_name: null }, error: null }],
      properties: [{ data: { avg_nightly_rate: 120 }, error: null }],
      owner_transactions: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleBookingConfirmed, {
      event: { data: { booking_id: 'bk_2', property_id: 'prop_1', org_id: 'org_1', source: 'ownerrez', actual_total_amount: null } },
      step:  makeStep(),
    })

    const upsertCall = supabase.calls.find((c) => c.table === 'owner_transactions' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toEqual(expect.objectContaining({
      source:      'booking_revenue',
      amount:      240,
      description: '2 nights',
    }))
    // A repeat estimate (no real total) must not clobber an already-posted
    // actual figure — ignoreDuplicates stays true for estimate-only posts.
    expect(upsertCall?.args[1]).toEqual({ ...IDEMPOTENT_UPSERT_OPTS, ignoreDuplicates: true })
  })

  it('skips posting and reports the error when the booking has an unparseable date, without touching owner_transactions', async () => {
    const supabase = makeSupabase({
      bookings:   [{ data: { checkin_date: 'not-a-date', checkout_date: '2026-08-03', guest_name: null }, error: null }],
      properties: [{ data: { avg_nightly_rate: 100 }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleBookingConfirmed, {
      event: { data: { booking_id: 'bk_3', property_id: 'prop_1', org_id: 'org_1', source: 'ownerrez', actual_total_amount: null } },
      step:  makeStep(),
    })

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.booking-confirmed.invalid_date', orgId: 'org_1' }),
    )
    expect(supabase.calls.some((c) => c.table === 'owner_transactions')).toBe(false)
    expect(result).toEqual({ booking_id: 'bk_3' })
  })
})

describe('handleBookingDetected', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs turnover generation and fires turnover/created events even when the (non-fatal) revenue step is skipped', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { avg_nightly_rate: null }, error: null }], // revenue step skips: 'no_rate', before ever querying bookings
      turnovers: [{
        data: [
          { id: 'to_1', checkout_datetime: '2026-08-03T10:00:00Z', checkin_datetime: '2026-08-03T15:00:00Z', window_minutes: 300 },
          { id: 'to_2', checkout_datetime: '2026-08-05T10:00:00Z', checkin_datetime: '2026-08-05T15:00:00Z', window_minutes: 300 },
        ],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue(['to_1', 'to_2'])

    const step = makeStep()
    const result = await invokeHandler(handleBookingDetected, {
      event: {
        data: {
          booking_id: 'bk_4', property_id: 'prop_1', org_id: 'org_1',
          guest_name: 'G', guest_email: 'g@example.com',
          checkin_date: '2026-08-01', checkout_date: '2026-08-03',
        },
      },
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(step.sendEvent).toHaveBeenCalledWith('fire-turnover-created-events', [
      {
        name: 'turnover/created',
        data: {
          turnover_id: 'to_1', property_id: 'prop_1', org_id: 'org_1',
          checkout_datetime: '2026-08-03T10:00:00Z', checkin_datetime: '2026-08-03T15:00:00Z', window_minutes: 300,
        },
      },
      {
        name: 'turnover/created',
        data: {
          turnover_id: 'to_2', property_id: 'prop_1', org_id: 'org_1',
          checkout_datetime: '2026-08-05T10:00:00Z', checkin_datetime: '2026-08-05T15:00:00Z', window_minutes: 300,
        },
      },
    ])
    // Revenue step never reached the bookings table — it short-circuited
    // on the missing avg_nightly_rate before that query.
    expect(supabase.calls.some((c) => c.table === 'bookings')).toBe(false)
    expect(result).toEqual({ booking_id: 'bk_4', newTurnoverIds: ['to_1', 'to_2'] })
  })

  it('does not fire any turnover/created events when no new turnovers are generated', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { avg_nightly_rate: 150 }, error: null }],
      bookings:   [{ data: { checkin_date: '2026-08-01', checkout_date: '2026-08-03', guest_name: 'X' }, error: null }],
      owner_transactions: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const step = makeStep()
    const result = await invokeHandler(handleBookingDetected, {
      event: {
        data: {
          booking_id: 'bk_5', property_id: 'prop_1', org_id: 'org_1',
          guest_name: 'X', guest_email: null,
          checkin_date: '2026-08-01', checkout_date: '2026-08-03',
        },
      },
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ booking_id: 'bk_5', newTurnoverIds: [] })
  })
})
