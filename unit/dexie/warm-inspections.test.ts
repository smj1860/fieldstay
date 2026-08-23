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

/**
 * A minimal PostgREST builder. Every filter returns `this`, so the chain under
 * test is exercised as written; only the terminal await differs by table.
 */
function fakeSupabase() {
  return {
    from(table: string) {
      const byTable: Record<string, () => { data: unknown; error: unknown }> = {
        inspections:              () => inspectionRows,
        property_assets:          () => assetRows,
        inspection_forms:         () => formRows,
        inspection_form_sections: () => sectionRows,
        inspection_form_items:    () => itemRows,
        properties:               () => propertyRows,
      }
      const result = byTable[table] ?? (() => ({ data: [], error: null }))
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
        builder[m] = () => builder
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
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
  inspectionRows = { data: [], error: null }
  assetRows      = { data: [], error: null }
  // A library that caches by default, since almost every test needs one and
  // only the library-specific tests care about its contents.
  formRows     = { data: [{ id: 'f1', key: 'safety', version: 1, is_active: true, name: 'Safety' }], error: null }
  sectionRows  = { data: [{ id: 's1', form_id: 'f1' }], error: null }
  itemRows     = { data: [{ id: 'i1', section_id: 's1' }], error: null }
  propertyRows = { data: [{ id: 'prop-1', org_id: ORG, name: 'Lake House' }], error: null }
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
  it('does nothing offline, and says so', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(await warmInspectionsForOffline(USER, ORG))
      .toMatchObject({ skipped: 'offline' })
    expect(fetchMock).not.toHaveBeenCalled()
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
