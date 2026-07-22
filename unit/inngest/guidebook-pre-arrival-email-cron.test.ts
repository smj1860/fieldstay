import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  sendGuestPreArrivalEmail: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })),
}))

import { guidebookPreArrivalEmailCron } from '@/lib/inngest/functions/guidebook-pre-arrival-email-cron'
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
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

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

describe('guidebookPreArrivalEmailCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the pre-arrival email for a booking checking in tomorrow at an active-guidebook org and marks it sent', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [bookingRow()], error: null },  // fetch-tomorrow-bookings
        { data: null, error: null },            // mark-sent update
      ],
      guidebook_configurations: [
        { data: [{ org_id: 'org_1' }], error: null },
      ],
      properties: [
        { data: [{ id: 'prop_1', name: 'Lake House' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 1, eligible: 1 })
    expect(sendGuestPreArrivalEmail).toHaveBeenCalledWith({
      toEmail:      'guest@example.com',
      guestName:    'Alex Guest',
      propertyName: 'Lake House',
      optInUrl:     expect.stringContaining('/g/b/tok_abc123/opt-in'),
      guidebookUrl: expect.stringContaining('/g/b/tok_abc123'),
    })

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ guidebook_pre_arrival_email_sent_at: expect.any(String) })
  })

  it('is a no-op when no bookings check in tomorrow', async () => {
    const supabase = makeSupabase({
      bookings: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0 })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
  })

  it('excludes a booking whose org guidebook is not active — never emails it', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [bookingRow({ org_id: 'org_inactive' })], error: null },
      ],
      guidebook_configurations: [
        { data: [], error: null }, // org_inactive has no active guidebook config row
      ],
      properties: [
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, eligible: 0 })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
  })

  it('skips a booking whose property could not be found in the batch lookup, without crashing the run', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [bookingRow()], error: null },
      ],
      guidebook_configurations: [
        { data: [{ org_id: 'org_1' }], error: null },
      ],
      properties: [
        { data: [], error: null }, // property missing from batch fetch
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookPreArrivalEmailCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, eligible: 1 })
    expect(sendGuestPreArrivalEmail).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
  })
})
