import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'
import type { Inspection, PropertyAsset } from '@/types/database'

// ============================================================================
// A PM SHOULD NOT HAVE TO OPEN THE INSPECTION BEFORE DRIVING TO THE PROPERTY.
//
// Both halves of the fill screen were lazy, and each was independently fatal:
// sw.js caches a document only for a URL that has been navigated to, and
// pullInspection ran on that page's own mount. So the first tap at the house
// got the offline page, and a cached document would have rendered "not on this
// device yet".
//
// Warming one without the other buys nothing, so these tests check BOTH land
// from a single pass — and that the pass stays quiet when it should.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const inspection = (id: string, over: Partial<Inspection> = {}): Inspection => ({
  id, org_id: ORG, property_id: 'prop-1',
  form_id: 'f1', form_version: 1, form_snapshot: {}, header_snapshot: null,
  assigned_to_user_id: USER, inspector_name: null,
  scheduled_for: null, started_at: '2026-08-22T10:00:00Z',
  started_at_source: 'server', device_started_at: null, device_clock_offset_seconds: null,
  completed_at: null, completed_by_user_id: null,
  source_schedule_id: null, corrects_inspection_id: null,
  created_at: '2026-08-22T10:00:00Z', updated_at: '2026-08-22T10:00:00Z',
  ...over,
})

const propertyAsset = (id: string, over: Partial<PropertyAsset> = {}) => ({
  id, org_id: ORG, property_id: 'prop-1', name: 'Fridge',
  asset_type: 'refrigerator', is_active: true, ...over,
} as PropertyAsset)

// ── Test doubles ────────────────────────────────────────────────────────────

let inspectionRows: { data: unknown; error: unknown } = { data: [], error: null }
let assetRows:      { data: unknown; error: unknown } = { data: [], error: null }
let formRows:       { data: unknown; error: unknown } = { data: [], error: null }
let sectionRows:    { data: unknown; error: unknown } = { data: [], error: null }
let itemRows:       { data: unknown; error: unknown } = { data: [], error: null }
let propertyRows:   { data: unknown; error: unknown } = { data: [], error: null }
let scheduleRows:   { data: unknown; error: unknown } = { data: [], error: null }

// See the sibling note in warm-maintenance-board.test.ts: getSession() performs
// the refresh, so null models a session that has lapsed and cannot be renewed.
let session: unknown = { access_token: 'jwt' }

// When set, each getSession() call SHIFTS the next value off this queue
// instead of reading the standing `session` var above — lets a test model a
// session that is valid for the pass's first check and lapses partway
// through, without disturbing every other test's simpler `session` toggle.
// The last value repeats once the queue is exhausted.
let sessionSequence: unknown[] | null = null
let sessionCalls = 0

// Fires exactly when the `inspections` SELECT's response is being read — lets
// a test hold one call's pass open at a controlled point, the same way
// warm-maintenance-board.test.ts's onWorkOrdersRead does.
let onInspectionsRead: (() => Promise<void>) | null = null

/**
 * A minimal PostgREST builder. Every filter returns `this`, so the chain under
 * test is exercised as written; only the terminal await differs by table.
 */
function fakeSupabase() {
  return {
    auth: {
      getSession: async () => {
        sessionCalls++
        if (sessionSequence) {
          const next = sessionSequence.length > 1 ? sessionSequence.shift() : sessionSequence[0]
          return { data: { session: next }, error: null }
        }
        return { data: { session }, error: null }
      },
    },
    from(table: string) {
      const byTable: Record<string, () => { data: unknown; error: unknown }> = {
        inspections:              () => inspectionRows,
        property_assets:          () => assetRows,
        inspection_forms:         () => formRows,
        inspection_form_sections: () => sectionRows,
        inspection_form_items:    () => itemRows,
        properties:               () => propertyRows,
        maintenance_schedules:    () => scheduleRows,
      }
      const result = byTable[table] ?? (() => ({ data: [], error: null }))
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
        builder[m] = () => builder
      }
      builder.then = (resolve: (v: unknown) => unknown) => {
        const hook = table === 'inspections' ? onInspectionsRead : null
        return (hook ? hook() : Promise.resolve()).then(() => resolve(result()))
      }
      return builder
    },
  }
}

const cachePut = vi.fn()
const fetchMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({ createClient: () => fakeSupabase() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const { warmInspectionsForOffline } = await import('@/lib/dexie/dashboard/warm-inspections')
const { SHELL_CACHE } = await import('@/lib/pwa/cache-names')

beforeEach(async () => {
  inspectionRows    = { data: [], error: null }
  assetRows         = { data: [], error: null }
  session           = { access_token: 'jwt' }
  sessionSequence   = null
  sessionCalls      = 0
  onInspectionsRead = null
  // A library that caches by default, since almost every test needs one and
  // only the library-specific tests care about its contents.
  formRows     = { data: [{ id: 'f1', key: 'safety', version: 1, is_active: true, name: 'Safety' }], error: null }
  sectionRows  = { data: [{ id: 's1', form_id: 'f1' }], error: null }
  itemRows     = { data: [{ id: 'i1', section_id: 's1' }], error: null }
  propertyRows = { data: [{ id: 'prop-1', org_id: ORG, name: 'Lake House' }], error: null }
  scheduleRows = { data: [], error: null }
  cachePut.mockReset()
  fetchMock.mockReset().mockResolvedValue({ ok: true, redirected: false, clone: () => ({}) })

  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ put: cachePut }) })

  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await Promise.all([
    db.inspections.clear(), db.property_assets.clear(), db.sync_meta.clear(),
    db.inspection_forms.clear(), db.inspection_form_sections.clear(),
    db.inspection_form_items.clear(), db.properties.clear(),
    db.maintenance_schedules.clear(),
  ])
})

afterEach(() => { vi.unstubAllGlobals() })

describe('warmInspectionsForOffline', () => {
  it('caches the inspection AND warms its page in one pass', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }
    assetRows      = { data: [propertyAsset('asset-1')], error: null }

    const result = await warmInspectionsForOffline(USER, ORG)

    // Two routes: the list (so a walk can be STARTED offline) and this
    // inspection's own page.
    expect(result).toMatchObject({ inspections: 1, routes: 2 })
    // The data half.
    expect(await getDashboardDb(USER, ORG).inspections.get('insp-1')).toBeTruthy()
    expect(await getDashboardDb(USER, ORG).property_assets.get('asset-1')).toBeTruthy()
    // The page half, at the URL the PM will actually tap.
    expect(fetchMock).toHaveBeenCalledWith('/maintenance/inspections/insp-1', expect.anything())
    expect(cachePut).toHaveBeenCalledWith('/maintenance/inspections/insp-1', expect.anything())
  })

  it('fetches the page WITH credentials', async () => {
    // An uncredentialed fetch caches a redirect to /login, which is worse than
    // caching nothing: it would then be SERVED at the property.
    inspectionRows = { data: [inspection('insp-1')], error: null }
    await warmInspectionsForOffline(USER, ORG)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' })
  })

  it('uses the same cache the service worker reads', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }
    await warmInspectionsForOffline(USER, ORG)
    expect((caches.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(SHELL_CACHE)
  })

  it('never caches a redirect or an error page', async () => {
    // A login redirect or a 500 cached here is a trap that outlives the outage
    // that produced it — and it is served at the house, where there is no way
    // to clear it.
    inspectionRows = { data: [inspection('insp-1'), inspection('insp-2')], error: null }
    fetchMock
      .mockResolvedValueOnce({ ok: true,  redirected: true,  clone: () => ({}) })
      .mockResolvedValueOnce({ ok: false, redirected: false, clone: () => ({}) })
      .mockResolvedValueOnce({ ok: false, redirected: false, clone: () => ({}) })

    const result = await warmInspectionsForOffline(USER, ORG)
    expect(result.routes).toBe(0)
    expect(cachePut).not.toHaveBeenCalled()
  })

  it('a failed route does not abandon the rest', async () => {
    inspectionRows = { data: [inspection('insp-1'), inspection('insp-2')], error: null }
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, redirected: false, clone: () => ({}) })

    expect((await warmInspectionsForOffline(USER, ORG)).routes).toBe(2)
  })

  it('caches the inspections even when the ASSET query fails', async () => {
    // The fill screen still renders and its own pull corrects the asset set.
    // Refusing to cache anything would trade a partial win for nothing.
    inspectionRows = { data: [inspection('insp-1')], error: null }
    assetRows      = { data: null, error: { message: 'boom' } }

    await warmInspectionsForOffline(USER, ORG)
    expect(await getDashboardDb(USER, ORG).inspections.get('insp-1')).toBeTruthy()
  })

  it('a retired asset is REMOVED, not left to open a section gate', async () => {
    // Reconcile-by-absence. §12.3's well section is gated on an active
    // well_pump, so a stale cached asset would keep asking nine well questions
    // at a property that no longer has a well.
    const db = getDashboardDb(USER, ORG)
    await db.property_assets.put(propertyAsset('retired', { asset_type: 'well_pump' }))

    inspectionRows = { data: [inspection('insp-1')], error: null }
    assetRows      = { data: [propertyAsset('live')], error: null }

    await warmInspectionsForOffline(USER, ORG)

    expect(await db.property_assets.get('retired')).toBeUndefined()
    expect(await db.property_assets.get('live')).toBeTruthy()
  })

  it('leaves ANOTHER property’s cached assets alone', async () => {
    // The empty-set trap the absence-reconciliation guardrail is about, in
    // miniature: this fetch covers only the properties with open inspections,
    // so it must not reconcile the whole table.
    const db = getDashboardDb(USER, ORG)
    await db.property_assets.put(propertyAsset('elsewhere', { property_id: 'prop-OTHER' }))

    inspectionRows = { data: [inspection('insp-1')], error: null }
    assetRows      = { data: [], error: null }

    await warmInspectionsForOffline(USER, ORG)
    expect(await db.property_assets.get('elsewhere')).toBeTruthy()
  })

  it('a FAILED inspection query wipes nothing', async () => {
    // `null` from the fetch means the query errored, which is not the same as
    // "there are no open inspections". Treating them alike would empty a
    // perfectly good cache on a blip.
    const db = getDashboardDb(USER, ORG)
    await db.inspections.put(inspection('already-cached'))
    inspectionRows = { data: null, error: { message: 'boom' } }

    await warmInspectionsForOffline(USER, ORG)
    expect(await db.inspections.get('already-cached')).toBeTruthy()
  })
})

describe('warmInspectionsForOffline — when it declines to run', () => {
  // ── §7's due list ────────────────────────────────────────────────────────
  //
  // An inspection schedule NOTIFIES and creates nothing, so the only thing that
  // turns a due schedule into a walk is a PM tapping Start — at the property,
  // where the list has to already be on the device.

  const schedule = (id: string, over: Record<string, unknown> = {}) => ({
    id, org_id: ORG, property_id: 'prop-1', name: 'Quarterly safety walk',
    creates: 'inspection', is_active: true,
    next_due_date: '2026-09-01', inspection_form_id: 'f1', ...over,
  })

  it('caches the org\u2019s inspection schedules', async () => {
    scheduleRows = { data: [schedule('sched-1')], error: null }

    const result = await warmInspectionsForOffline(USER, ORG)

    expect(result).toMatchObject({ schedules: 1 })
    expect(await getDashboardDb(USER, ORG).maintenance_schedules.get('sched-1')).toBeTruthy()
  })

  it('lands them for an org with NO open inspections', async () => {
    // The case that matters most, and the one an implementation hung off the
    // inspection loop would miss: an org with nothing open is precisely the one
    // whose next act is starting the walk a schedule is asking for.
    inspectionRows = { data: [], error: null }
    scheduleRows   = { data: [schedule('sched-1')], error: null }

    const result = await warmInspectionsForOffline(USER, ORG)

    expect(result).toMatchObject({ inspections: 0, schedules: 1 })
    expect(await getDashboardDb(USER, ORG).maintenance_schedules.get('sched-1')).toBeTruthy()
    // And the start screen is still reachable with no signal.
    expect(cachePut).toHaveBeenCalledWith('/maintenance/inspections', expect.anything())
  })

  it('a FAILED schedule query keeps the cached copy', async () => {
    // A failed fetch is not evidence that nothing is scheduled. Clearing here
    // would hide every due walk from a device that had a perfectly good list.
    await getDashboardDb(USER, ORG).maintenance_schedules.put(schedule('sched-old') as never)
    scheduleRows = { data: null, error: { message: 'connection reset' } }

    const result = await warmInspectionsForOffline(USER, ORG)

    expect(result).toMatchObject({ schedules: 0 })
    expect(await getDashboardDb(USER, ORG).maintenance_schedules.get('sched-old')).toBeTruthy()
  })

  it('an EMPTY result does clear \u2014 a deleted schedule stops being due', async () => {
    // The other half of the empty-set question, and the opposite answer to the
    // form library's: empty is a legitimate steady state for org data, so a
    // schedule the PM deleted must stop asking to be walked. Safe only because
    // the error branch above returns first.
    await getDashboardDb(USER, ORG).maintenance_schedules.put(schedule('sched-gone') as never)
    scheduleRows = { data: [], error: null }

    await warmInspectionsForOffline(USER, ORG)

    expect(await getDashboardDb(USER, ORG).maintenance_schedules.get('sched-gone')).toBeUndefined()
  })

  it('does nothing offline, and says so', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(await warmInspectionsForOffline(USER, ORG))
      .toMatchObject({ skipped: 'offline' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── The 2026-09-11 false alarm ────────────────────────────────────────────
  //
  // Four Sentry issues in 1.1 seconds — 42501 on maintenance_schedules,
  // inspection_forms, vendors and inspections — read as an RLS regression
  // across four tables in one org. They were one tab whose session had lapsed:
  // 42501 is a GRANT failure checked before RLS, `anon` holds no table grants,
  // so every read of the pass failed the same way. The gate runs before the
  // first query, and `force` must not bypass it — the inspections view passes
  // force on every mount, which is exactly the mount a lapsed tab performs.
  it('makes no query at all when the session has lapsed', async () => {
    session        = null
    inspectionRows = { data: [inspection('insp-1')], error: null }
    scheduleRows   = { data: [{ id: 'sched-1', org_id: ORG, creates: 'inspection' }], error: null }

    const result = await warmInspectionsForOffline(USER, ORG)

    expect(result).toMatchObject({ skipped: 'unauthenticated', inspections: 0, formItems: 0, schedules: 0 })
    const db = getDashboardDb(USER, ORG)
    expect(await db.inspections.get('insp-1')).toBeUndefined()
    expect(await db.maintenance_schedules.get('sched-1')).toBeUndefined()
    // The route half is auth-gated too: an uncredentialed warm caches a login
    // redirect, which is worse than caching nothing.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a lapsed session does not bypass the gate via force', async () => {
    session = null
    expect(await warmInspectionsForOffline(USER, ORG, { force: true }))
      .toMatchObject({ skipped: 'unauthenticated' })
  })

  // A session that is fine at the TOP of the pass but lapses before the
  // mid-pass query is a different failure than the all-or-nothing case above
  // — this is the flaky-connection case the mid-pass re-check exists for. The
  // queue's second entry (null) is what the second hasUsableSession() call
  // reads; without that re-check, fetchOpenInspections would run anyway and
  // 'insp-1' would land in the cache despite the lapsed session.
  it('bails mid-pass when the session lapses AFTER the form library warms but before inspections fetch', async () => {
    sessionSequence = [{ access_token: 'jwt' }, null]
    inspectionRows  = { data: [inspection('insp-1')], error: null }

    const result = await warmInspectionsForOffline(USER, ORG)

    expect(result).toMatchObject({ skipped: 'unauthenticated', inspections: 0 })
    // The library warm, which ran BEFORE the session lapsed, is still kept —
    // only the tail of the pass is abandoned.
    expect(result.formItems).toBeGreaterThan(0)
    expect(await getDashboardDb(USER, ORG).inspections.get('insp-1')).toBeUndefined()
    expect(sessionCalls).toBeGreaterThanOrEqual(2)
  })

  it('throttles, so mounting on every dashboard page is not a request storm', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }
    await warmInspectionsForOffline(USER, ORG)
    fetchMock.mockClear()

    expect(await warmInspectionsForOffline(USER, ORG)).toMatchObject({ skipped: 'throttled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('force bypasses the throttle', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }
    await warmInspectionsForOffline(USER, ORG)
    fetchMock.mockClear()

    expect((await warmInspectionsForOffline(USER, ORG, { force: true })).routes).toBe(2)
  })

  it('stamps the watermark even with nothing to warm', async () => {
    // Otherwise an org with no open inspections re-queries on every dashboard
    // mount forever — the case the throttle matters most for.
    inspectionRows = { data: [], error: null }
    await warmInspectionsForOffline(USER, ORG)

    expect(await warmInspectionsForOffline(USER, ORG)).toMatchObject({ skipped: 'throttled' })
  })

  it('an unparseable watermark warms rather than never warming again', async () => {
    // `Date.parse('nonsense')` is NaN, and every comparison against NaN is
    // false — so a naive check would disable warming permanently and silently.
    const db = getDashboardDb(USER, ORG)
    await db.sync_meta.put({ key: 'inspections:last_warm_at', value: 'nonsense' })
    inspectionRows = { data: [inspection('insp-1')], error: null }

    expect((await warmInspectionsForOffline(USER, ORG)).inspections).toBe(1)
  })
})

describe('warmInspectionsForOffline — concurrent callers', () => {
  // React Strict Mode's mount/cleanup/remount double-invoke, and a tablet
  // reconnecting right as the layout mounts, both call this before either
  // call has written the watermark. Without the in-flight map, both would
  // read isDue() as false and run a full pass each — doubling outbound
  // requests on the flaky connection this feature exists for, and letting
  // two reconcile-by-absence transactions interleave.
  it('two un-forced calls started back to back share ONE pass', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }

    const first  = warmInspectionsForOffline(USER, ORG)
    const second = warmInspectionsForOffline(USER, ORG)

    // Same promise, not just an equivalent result — the second call never
    // started its own pass at all.
    expect(second).toBe(first)

    const sessionCallsBefore = sessionCalls
    await Promise.all([first, second])
    // Exactly the calls one pass makes (the top check plus mid-pass
    // re-checks) — a second concurrent pass would double this.
    expect(sessionCalls - sessionCallsBefore).toBeLessThanOrEqual(3)
  })

  it('a FORCED call does not join an un-forced pass already in flight, and each forced call gets its own run', async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }

    const background = warmInspectionsForOffline(USER, ORG)
    const forcedA     = warmInspectionsForOffline(USER, ORG, { force: true })
    const forcedB     = warmInspectionsForOffline(USER, ORG, { force: true })

    // force always starts a new run rather than joining ANY existing one —
    // the in-flight map exists to dedupe accidental double-mounts, not to
    // throttle a deliberate re-warm.
    expect(forcedA).not.toBe(background)
    expect(forcedB).not.toBe(forcedA)

    await Promise.all([background, forcedA, forcedB])
  })

  // The `.finally()` cleanup only deletes the map entry when it still points
  // at ITS OWN run: `if (inFlight.get(key) === run)`. This is what stops an
  // OLDER call's cleanup from evicting a NEWER call's still-running entry —
  // exercised here by making the first forced call finish before the second
  // one does, then confirming a third (un-forced) call still JOINS the
  // second rather than starting a redundant fourth pass because the map
  // entry was wiped out from under it.
  it("an older forced call's cleanup does not evict a newer forced call's still-running entry", async () => {
    inspectionRows = { data: [inspection('insp-1')], error: null }

    // A queue rather than two nullable variables — avoids TS narrowing a
    // closure-mutated `let` back to `never` across the `await` below, and
    // reads just as clearly: releases[0] is the first read to arrive, [1]
    // the second.
    const releases: Array<() => void> = []
    onInspectionsRead = () => new Promise<void>((resolve) => { releases.push(resolve) })

    const forcedA = warmInspectionsForOffline(USER, ORG, { force: true })
    const forcedB = warmInspectionsForOffline(USER, ORG, { force: true })

    // Both calls have several real (non-microtask) awaits ahead of the
    // inspections read — the session checks, the form-library Promise.all,
    // the schedule query — so the gate isn't installed synchronously. Poll
    // with a macrotask tick rather than assuming a fixed number of microtask
    // flushes gets there.
    while (releases.length < 1) await new Promise((r) => setTimeout(r, 0))
    releases[0]!()
    await forcedA

    // forcedB is still pending (its release not yet called). A plain call
    // now must JOIN it, not start a third pass.
    const third = warmInspectionsForOffline(USER, ORG)
    expect(third).toBe(forcedB)

    while (releases.length < 2) await new Promise((r) => setTimeout(r, 0))
    releases[1]!()
    await Promise.all([forcedB, third])
  })
})
