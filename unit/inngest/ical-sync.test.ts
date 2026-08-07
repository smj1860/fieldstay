import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// See ownerrez-incremental-sync.test.ts for the canonical explanation of the
// queue-based-supabase mock pattern used throughout this file. ical-sync.ts
// has three functions in one source file (syncAllIcalFeeds fans out to orgs,
// syncOrgIcalFeeds fans out that org's feeds, syncIcalFeed does the per-feed
// work) — the whole dispatcher chain is covered together here, the same way
// work-order-dispatch.test.ts covers workOrderDispatch and workOrderSignedOff
// in one file.

// ── DNS boundary ────────────────────────────────────────────────────────────
// syncIcalFeed downloads through safeFetch (lib/security/url-guard.ts), which
// really resolves the hostname before connecting so a public-looking name with
// a private A record can't be used for SSRF. `feeds.example.com` doesn't
// resolve from CI, so the *resolver* is what gets stubbed — NOT the guard.
// Scheme checks, literal-IP normalization, private-range blocking and
// per-redirect-hop re-validation all still execute for real against these
// answers, and the "still rejects" tests at the bottom of this file prove it.
const dnsAnswers: Record<string, string[]> = {
  'feeds.example.com':          ['93.184.216.34'],   // public
  'internal.attacker.example':  ['10.0.0.5'],        // public name, RFC1918 answer
  'split.attacker.example':     ['93.184.216.34', '169.254.169.254'], // one good, one metadata
}

const lookupMock = vi.fn(async (hostname: string) => {
  const addresses = dnsAnswers[hostname]
  if (!addresses) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
    throw err
  }
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
})

vi.mock('node:dns/promises', () => ({ lookup: (...args: [string]) => lookupMock(...args) }))

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
  cancelTurnoversForBooking:      vi.fn().mockResolvedValue([]),
  notifyCrewOfCancelledTurnovers: vi.fn(),
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
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { syncAllIcalFeeds, syncOrgIcalFeeds, syncIcalFeed } from '@/lib/inngest/functions/ical-sync'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import { parseIcalFeed } from '@/lib/ical/parser'
import { cancelTurnoversForBooking, notifyCrewOfCancelledTurnovers } from '@/lib/turnovers/generator'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'
import { getPmEmails } from '@/lib/inngest/helpers'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => undefined),
  }
}

function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

/** The (name, payload) pair a `step.sendEvent` spy recorded for call `index`. */
function sentEvent<T>(step: { sendEvent: { mock: { calls: unknown[] } } }, index = 0): [string, T] {
  return step.sendEvent.mock.calls[index] as unknown as [string, T]
}

/** A fetch Response shaped enough for safeFetch (status + headers + text). */
function makeResponse(init: {
  status?:   number
  body?:     string
  location?: string
} = {}) {
  const status = init.status ?? 200
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? init.location ?? null : null) },
    text:    async () => init.body ?? 'BEGIN:VCALENDAR\nEND:VCALENDAR',
  }
}

const originalFetch = globalThis.fetch

describe('syncAllIcalFeeds (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans out one ical/sync.org.requested per org holding an active feed', async () => {
    const supabase = makeSupabase({
      ical_feeds: [
        { data: [{ org_id: 'org_1' }, { org_id: 'org_2' }, { org_id: 'org_1' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: {} },
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-org-syncs', [
      { name: 'ical/sync.org.requested', data: { org_id: 'org_1' } },
      { name: 'ical/sync.org.requested', data: { org_id: 'org_2' } },
    ])
    expect(result).toEqual({ dispatched: 2 })
  })

  it('is a no-op when no org has an active iCal feed', async () => {
    const supabase = makeSupabase({ ical_feeds: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: {} },
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ dispatched: 0 })
  })

  it('dispatches only the requested org, without a discovery query, on the manual/UI-triggered path', async () => {
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    // The org is known already — the platform-wide discovery scan is skipped
    // entirely rather than run and then filtered.
    expect(supabase.from).not.toHaveBeenCalled()
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-org-syncs', [
      { name: 'ical/sync.org.requested', data: { org_id: 'org_1' } },
    ])
    expect(result).toEqual({ dispatched: 1 })
  })

  it('pages through org discovery, so a platform with >1000 feed rows still dispatches every tenant', async () => {
    // This is the original bug: one unbounded `.select()` returned PostgREST's
    // first 1000 rows with no error, and every feed past it silently stopped
    // syncing. 2,400 single-feed orgs is ~17 tenants' worth past the cap.
    const rows = Array.from({ length: 2_400 }, (_, i) => ({ org_id: `org_${i}` }))
    const supabase = makeSupabase({ ical_feeds: [{ data: rows, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(syncAllIcalFeeds, {
      event:  { data: {} },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2_400 })
    const [, dispatched] = sentEvent<{ data: { org_id: string } }[]>(step)
    expect(dispatched.at(-1)!.data.org_id).toBe('org_2399')
    expect(supabase.calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
      [0, 999], [1000, 1999], [2000, 2999],
    ])
  })
})

describe('syncOrgIcalFeeds (per-org fan-out)', () => {
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

    const result = await invokeHandler(syncOrgIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
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

  it('scopes the feed query to the event org', async () => {
    const supabase = makeSupabase({
      ical_feeds: [{ data: [{ id: 'feed_1', property_id: 'prop_1', org_id: 'org_1' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(syncOrgIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(supabase.eqSpy).toHaveBeenCalledWith('ical_feeds', 'is_active', true)
    expect(supabase.eqSpy).toHaveBeenCalledWith('ical_feeds', 'org_id', 'org_1')
  })

  it('is a no-op when the org has no active feeds', async () => {
    const supabase = makeSupabase({ ical_feeds: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(syncOrgIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ synced: 0 })
  })

  it('pages through a >1000-feed org rather than syncing only the first page', async () => {
    const feeds = Array.from({ length: 1_300 }, (_, i) => ({
      id: `feed_${i}`, property_id: `prop_${i}`, org_id: 'org_1',
    }))
    const supabase = makeSupabase({ ical_feeds: [{ data: feeds, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(syncOrgIcalFeeds, {
      event:  { data: { org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ synced: 1_300 })
    const [, dispatched] = sentEvent<{ data: { feed_id: string } }[]>(step)
    expect(dispatched).toHaveLength(1_300)
    expect(dispatched.at(-1)!.data.feed_id).toBe('feed_1299')
  })
})

describe('syncIcalFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(async () => makeResponse()) as unknown as typeof fetch
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

  it('pages through a feed with more than 1000 stored bookings when building the existing-UID map', async () => {
    // A truncated "existing" map is not a quiet no-op: every unread booking
    // looks brand new (re-firing booking/detected) and simultaneously drops
    // out of the cancel-absent pass. 1,400 stored UIDs, all still present in
    // the feed → correct behaviour is zero new bookings and zero cancels.
    const stored = Array.from({ length: 1_400 }, (_, i) => ({
      id: `booking_${i}`, ical_uid: `uid_${i}`, status: 'confirmed', guest_email: null,
    }))
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue(
      stored.map((b) => ({
        uid: b.ical_uid, guestName: 'Guest', start: '2026-08-01', end: '2026-08-05', status: 'confirmed',
      })),
    )
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        { data: stored, error: null },                                              // paginated existing scan
        { data: stored.map(({ id, ical_uid, status }) => ({ id, ical_uid, status })), error: null }, // upsert().select()
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(syncIcalFeed, {
      event:  baseEvent(),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ feed_id: 'feed_1', newBookings: 0, cancelled: 0 })
    const bookingRanges = supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'range')
    expect(bookingRanges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
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
            { id: 'booking_existing', ical_uid: 'uid_existing', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
            { id: 'booking_gone', ical_uid: 'uid_gone', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
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
    expect(notifyCrewOfCancelledTurnovers).toHaveBeenCalledWith([])
    expect(result).toEqual({ feed_id: 'feed_1', newBookings: 0, cancelled: 1 })
  })

  it('batches the crew notification across every cancelled booking in a single sync into one call', async () => {
    // Driven from a NON-empty feed on purpose. This used to use an empty parse
    // with two known bookings — which is now refused outright as a broken-feed
    // signature (see the empty-feed test below), so the batching behaviour it
    // is actually about needed a scenario that still reaches the cancel pass.
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([
      { uid: 'uid_still_here', guestName: 'Stays', start: new Date('2099-02-01'), end: new Date('2099-02-05'), status: 'confirmed' },
    ])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(cancelTurnoversForBooking as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' }])
      .mockResolvedValueOnce([{ turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_2' }])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        {
          data: [
            { id: 'booking_here',   ical_uid: 'uid_still_here', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
            { id: 'booking_gone_1', ical_uid: 'uid_gone_1',     status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
            { id: 'booking_gone_2', ical_uid: 'uid_gone_2',     status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
          ],
          error: null,
        },
        { data: [{ id: 'booking_here', ical_uid: 'uid_still_here', status: 'confirmed' }], error: null },
        { data: null, error: null },   // bulk-cancel update for both gone bookings
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() })

    expect(cancelTurnoversForBooking).toHaveBeenCalledTimes(2)
    expect(cancelTurnoversForBooking).toHaveBeenCalledWith('booking_gone_1', supabase)
    expect(cancelTurnoversForBooking).toHaveBeenCalledWith('booking_gone_2', supabase)
    expect(notifyCrewOfCancelledTurnovers).toHaveBeenCalledWith([
      { turnoverId: 'to_1', orgId: 'org_1', crewMemberId: 'crew_1' },
      { turnoverId: 'to_2', orgId: 'org_1', crewMemberId: 'crew_2' },
    ])
  })

  it('refuses to mass-cancel when the feed parses to ZERO events but bookings are known', async () => {
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([])
    ;(detectAndFlagOverlaps as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      ical_feeds: [
        { data: { url: 'https://feeds.example.com/foo.ics', source: 'airbnb', org_id: 'org_1' }, error: null },
        { data: null, error: null },
      ],
      bookings: [
        {
          data: [
            { id: 'booking_1', ical_uid: 'uid_1', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
            { id: 'booking_2', ical_uid: 'uid_2', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() })

    // A structurally valid VCALENDAR with zero VEVENTs parses cleanly to [].
    // (A non-iCal body never reaches here — ICAL.parse throws and the download
    // step fails the run.) A host regenerating the feed URL, unpublishing a
    // listing, or serving a placeholder produces exactly this shape, and it is
    // indistinguishable from a genuinely emptied calendar. Cancelling would
    // cancel every turnover and text the crew that their jobs are off.
    expect(cancelTurnoversForBooking).not.toHaveBeenCalled()
    expect(notifyCrewOfCancelledTurnovers).not.toHaveBeenCalled()
    expect(result).toMatchObject({ cancelled: 0 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.ical-sync.empty-feed-guard' }),
    )
  })

  it('does not cancel a past booking that simply aged out of the feed window', async () => {
    ;(parseIcalFeed as ReturnType<typeof vi.fn>).mockReturnValue([
      { uid: 'uid_future', guestName: 'Ahead', start: new Date('2099-02-01'), end: new Date('2099-02-05'), status: 'confirmed' },
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
            { id: 'booking_future', ical_uid: 'uid_future', status: 'confirmed', guest_email: null, checkout_date: '2099-01-01' },
            { id: 'booking_past',   ical_uid: 'uid_past',   status: 'confirmed', guest_email: null, checkout_date: '2020-01-05' },
          ],
          error: null,
        },
        { data: [{ id: 'booking_future', ical_uid: 'uid_future', status: 'confirmed' }], error: null },
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() })

    // Airbnb/VRBO feeds carry a rolling FUTURE window, so a completed stay
    // drops out on its own. Cancelling on absence reclassified finished stays
    // as cancelled — wrong in owner_transactions and the owner portal's P&L,
    // for every past booking, forever.
    expect(cancelTurnoversForBooking).not.toHaveBeenCalled()
    expect(result).toMatchObject({ cancelled: 0 })
  })

  it('marks the feed errored and re-throws when the feed URL is unreachable (non-2xx response)', async () => {
    globalThis.fetch = vi.fn(async () => makeResponse({ status: 404, body: '' })) as unknown as typeof fetch

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

  // ── SSRF guard is still live ──────────────────────────────────────────────
  // The DNS resolver above is stubbed so a test hostname resolves at all; the
  // guard itself is not. These four cases each take a different route through
  // lib/security/url-guard.ts and must all still be rejected before any
  // request leaves the process.

  function ssrfSupabase(url: string) {
    return makeSupabase({
      ical_feeds: [
        { data: { url, source: 'airbnb', org_id: 'org_1' }, error: null }, // fetch-feed-url
        { data: null, error: null },                                       // error-marking update
      ],
    })
  }

  it('still rejects a feed URL pointing straight at the cloud metadata address (169.254.169.254)', async () => {
    const supabase = ssrfSupabase('https://169.254.169.254/latest/meta-data/')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow(/Blocked private\/loopback IPv4 address/)

    expect(fetchSpy).not.toHaveBeenCalled()
    // A literal IP is checked directly and never handed to a resolver.
    expect(lookupMock).not.toHaveBeenCalled()
    expect(parseIcalFeed).not.toHaveBeenCalled()
    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'ical_feeds',
      expect.objectContaining({ last_sync_status: 'error' }),
    )
  })

  it('still rejects a public-looking hostname whose DNS answer is an RFC1918 address', async () => {
    const supabase = ssrfSupabase('https://internal.attacker.example/evil.ics')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow(/Blocked private\/loopback IPv4 address .*10\.0\.0\.5/)

    // The DNS path really ran — this is the branch the resolver stub feeds.
    expect(lookupMock).toHaveBeenCalledWith('internal.attacker.example', { all: true, verbatim: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still rejects a hostname that mixes one public and one private DNS answer', async () => {
    const supabase = ssrfSupabase('https://split.attacker.example/evil.ics')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow(/Blocked private\/loopback IPv4 address .*169\.254\.169\.254/)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still rejects a plaintext http feed URL on the scheme check alone', async () => {
    const supabase = ssrfSupabase('http://feeds.example.com/foo.ics')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow(/URL scheme http: not permitted/)

    expect(lookupMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still re-validates redirect hops — a 302 from a public feed host to the metadata address is blocked', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeResponse({ status: 302, location: 'https://169.254.169.254/latest/meta-data/' }),
    ) as unknown as typeof fetch

    const supabase = ssrfSupabase('https://feeds.example.com/foo.ics')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(syncIcalFeed, { event: baseEvent(), step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow(/Blocked private\/loopback IPv4 address/)

    // The first hop was fetched (it was legitimately public); the redirect
    // target never was.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect(parseIcalFeed).not.toHaveBeenCalled()
  })
})
