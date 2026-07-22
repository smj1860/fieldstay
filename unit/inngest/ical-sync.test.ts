import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// See ownerrez-incremental-sync.test.ts for the canonical explanation of the
// queue-based-supabase mock pattern used throughout this file. ical-sync.ts
// has two functions in one source file (syncAllIcalFeeds fans out,
// syncIcalFeed does per-feed work) — same cron+handler split covered
// together here as work-order-dispatch.test.ts covers workOrderDispatch and
// workOrderSignedOff in one file.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/ical/parser', () => ({
  parseIcalFeed:  vi.fn(),
  toDateString:   vi.fn((d: string) => String(d).slice(0, 10)),
  toTimeString:   vi.fn(() => '15:00:00'),
  isAllDay:       vi.fn(() => false),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  cancelTurnoversForBooking: vi.fn(),
}))
vi.mock('@/lib/ical/conflict-detection', () => ({
  detectAndFlagOverlaps: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html></html>'),
}))

import { syncAllIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { parseIcalFeed } from '@/lib/ical/parser'
import { cancelTurnoversForBooking } from '@/lib/turnovers/generator'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'
import { getPmEmails } from '@/lib/inngest/helpers'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => undefined),
  }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const upsertSpy = vi.fn()
  const updateSpy = vi.fn()
  const eqSpy     = vi.fn()

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn((column: string, value: unknown) => { eqSpy(table, column, value); return chain })
    chain.in     = vi.fn(() => chain)
    chain.update = vi.fn((payload: unknown) => { updateSpy(table, payload); return chain })
    chain.upsert = vi.fn((payload: unknown, opts: unknown) => { upsertSpy(table, payload, opts); return chain })

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = vi.fn(() => resolveNext())
    chain.maybeSingle = vi.fn(() => resolveNext())
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, upsertSpy, updateSpy, eqSpy }
}

const originalFetch = globalThis.fetch

describe('syncAllIcalFeeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans out one ical/sync.requested event per active feed, spread with a jittered timestamp', async () => {
    const supabase = makeSupabase({
      ical_feeds: [
        {
          data: [
            { id: 'feed_1', property_id: 'prop_1', org_id: 'org_1' },
            { id: 'feed_2', property_id: 'prop_2', org_id: 'org_1' },
          ],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: {} },
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).toHaveBeenCalledWith(
      'fan-out-feed-syncs',
      [
        expect.objectContaining({
          name: 'ical/sync.requested',
          data: { feed_id: 'feed_1', property_id: 'prop_1', org_id: 'org_1' },
          ts:   expect.any(Number),
        }),
        expect.objectContaining({
          name: 'ical/sync.requested',
          data: { feed_id: 'feed_2', property_id: 'prop_2', org_id: 'org_1' },
          ts:   expect.any(Number),
        }),
      ],
    )
    expect(result).toEqual({ synced: 2 })
  })

  it('is a no-op when there are no active iCal feeds', async () => {
    const supabase = makeSupabase({
      ical_feeds: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: {} },
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ synced: 0 })
  })

  it('scopes the feed query to a single org when the triggering event carries an org_id (manual/UI-triggered path)', async () => {
    const supabase = makeSupabase({
      ical_feeds: [{ data: [{ id: 'feed_1', property_id: 'prop_1', org_id: 'org_1' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(syncAllIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(supabase.eqSpy).toHaveBeenCalledWith('ical_feeds', 'is_active', true)
    expect(supabase.eqSpy).toHaveBeenCalledWith('ical_feeds', 'org_id', 'org_1')
  })
})

describe('syncIcalFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(async () => ({
      ok:   true,
      text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR',
    })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function baseEvent(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        feed_id:     'feed_1',
        property_id: 'prop_1',
        org_id:      'org_1',
        ...overrides,
      },
    }
  }

  it('upserts a new confirmed booking, fires booking/detected for it, and marks the feed synced successfully', async () => {
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([
      { uid: 'uid_new', guestName: 'Jane Doe', start: '2026-08-01', end: '2026-08-05', status: 'confirmed' },
    ])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null }, // fetch-feed-url
        { data: null, error: null }, // mark-sync-success update
      ],
      bookings: [
        { data: [], error: null }, // no existing bookings for this feed
        { data: [{ id: 'booking_1', ical_uid: 'uid_new', status: 'confirmed' }], error: null }, // upsert().select()
        {
          data: [{
            id: 'booking_1', guest_name: 'Jane Doe', guest_email: null,
            checkin_date: '2026-08-01', checkout_date: '2026-08-05',
          }],
          error: null,
        }, // build-downstream-events select
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncIcalFeed, {
      event:  baseEvent(),
      step,
      logger: makeLogger(),
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'bookings',
      expect.arrayContaining([expect.objectContaining({ ical_uid: 'uid_new', status: 'confirmed', org_id: 'org_1' })]),
      { onConflict: 'ical_feed_id,ical_uid', ignoreDuplicates: false },
    )
    expect(step.sendEvent).toHaveBeenCalledWith(
      'fire-downstream-events',
      [expect.objectContaining({
        name: 'booking/detected',
        data: expect.objectContaining({ booking_id: 'booking_1', property_id: 'prop_1', org_id: 'org_1' }),
      })],
    )
    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'ical_feeds',
      expect.objectContaining({ last_sync_status: 'success', last_sync_error: null }),
    )
    expect(result).toEqual({ feed_id: 'feed_1', newBookings: 1, cancelled: 0 })
  })

  it('is a no-op when the feed has no events — no upsert of new rows, no downstream events, feed still marked synced', async () => {
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        { data: [], error: null },   // no existing bookings
        { data: [], error: null },   // upsert([]).select() — empty
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncIcalFeed, {
      event:  baseEvent(),
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(cancelTurnoversForBooking).not.toHaveBeenCalled()
    expect(result).toEqual({ feed_id: 'feed_1', newBookings: 0, cancelled: 0 })
  })

  it('does not re-fire booking/detected for a UID already seen in a prior sync, and cancels (+ cancels turnovers for) a confirmed booking that dropped out of the feed', async () => {
    // Feed still contains uid_existing (already-known, still confirmed —
    // must not be treated as new) but no longer contains uid_gone.
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([
      { uid: 'uid_existing', guestName: 'Known Guest', start: '2026-08-10', end: '2026-08-12', status: 'confirmed' },
    ])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        {
          data: [
            { id: 'booking_existing', ical_uid: 'uid_existing', status: 'confirmed', guest_email: null },
            { id: 'booking_gone', ical_uid: 'uid_gone', status: 'confirmed', guest_email: null },
          ],
          error: null,
        }, // existing bookings for this feed
        { data: [{ id: 'booking_existing', ical_uid: 'uid_existing', status: 'confirmed' }], error: null }, // upsert().select() — only the still-present uid is upserted
        { data: null, error: null }, // bulk-cancel update for booking_gone
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncIcalFeed, {
      event:  baseEvent(),
      step,
      logger: makeLogger(),
    })

    // Idempotency: a UID that was already present and is still confirmed is
    // not "new" — no duplicate booking/detected event on repeat syncs.
    expect(step.sendEvent).not.toHaveBeenCalled()

    // The booking absent from the latest feed pull is bulk-cancelled and its
    // turnover cancelled.
    expect(supabase.updateSpy).toHaveBeenCalledWith('bookings', { status: 'cancelled' })
    expect(cancelTurnoversForBooking).toHaveBeenCalledWith('booking_gone', supabase)
    expect(cancelTurnoversForBooking).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ feed_id: 'feed_1', newBookings: 0, cancelled: 1 })
  })

  it('marks the feed errored and re-throws when the feed URL is unreachable (non-2xx response)', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })) as unknown as typeof fetch

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/gone.ics', source: 'airbnb', org_id: 'org_1' }, error: null }, // fetch-feed-url
        { data: null, error: null }, // error-marking update in the catch block
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step, logger: makeLogger() }),
    ).rejects.toThrow('HTTP 404')

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'ical_feeds',
      expect.objectContaining({ last_sync_status: 'error', last_sync_error: expect.stringContaining('404') }),
    )
    // Never reached the parse/upsert steps.
    expect(parseIcalFeed).not.toHaveBeenCalled()
  })

  it('throws before ever downloading when the stored feed row belongs to a different org than the triggering event', async () => {
    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_OTHER' }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent({ org_id: 'org_1' }), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow('org mismatch')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('alerts the PM once (idempotency-keyed per property per day) when a new overlap conflict is detected', async () => {
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'booking_a', source: 'airbnb', guestName: 'Jane Doe', checkinDate: '2026-08-01', checkoutDate: '2026-08-05' },
    ])
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@fieldstay.app'])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      properties:     [{ data: { name: 'Lake House' }, error: null }],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@fieldstay.app', subject: expect.stringContaining('Lake House') }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('overlap-conflict-prop_1-') }),
    )
  })
})
