import { describe, it, expect, vi, beforeEach } from 'vitest'

// initial-sync.ts runs ~20 sequential steps for a single connection (no
// per-connection loop, unlike incremental-sync.ts) and most of those steps'
// results ARE dereferenced later in the function (enrichTargets.length,
// propertiesNeedingChecklist.length, etc.) — so unlike a narrow single-step
// allowlist, these tests allow every step whose result the function reads
// afterward, and pick fixture data that makes the steps we don't care about
// (checklist templating, guidebook sync, asset seeding) take their trivial
// "nothing to do" branch. See financial-ledger-idempotency.test.ts for the
// base allowlist-step pattern this extends.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/ownerrez-api', () => ({
  OwnerRezApiClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
}))
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
  fetchOrgRoomTemplateData:       vi.fn(),
}))
vi.mock('@/lib/checklists/seed-default-room-templates', () => ({
  seedDefaultRoomTemplatesIfNeeded: vi.fn(),
}))
vi.mock('@/lib/asset-discovery/seed-from-amenities', () => ({
  seedPresentAssetsFromAmenities:        vi.fn(),
  seedAbsentOptionalAssetsFromAmenities: vi.fn(),
}))
vi.mock('@/lib/guidebook/sync', () => ({
  ensureGuidebookConfiguration:                   vi.fn(),
  createGuidebookPropertyConfigsForProperties:    vi.fn(),
  syncGuidebookConfigsFromProperty:               vi.fn(),
}))

import { ownerRezInitialSync } from '@/lib/inngest/functions/ownerrez/initial-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'
import { logAuditEvent } from '@/lib/audit'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezBooking, OwnerRezProperty } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeAllowlistStep(allowed: string[]) {
  return {
    run: vi.fn((name: string, cb: () => unknown) => (allowed.includes(name) ? cb() : Promise.resolve(undefined))),
    sleep: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const upsertSpy = vi.fn()
  const updateSpy = vi.fn()
  // integration_connections.metadata is now merged atomically via the
  // merge_integration_connection_metadata RPC (see
  // lib/integrations/connection-metadata.ts) instead of a
  // select-then-update round trip — writeSyncCount, update-last-synced, and
  // handle-sync-failure's metadata write all go through here now.
  const rpcSpy = vi.fn()
  const rpc = vi.fn((fnName: string, args: unknown) => {
    rpcSpy(fnName, args)
    return Promise.resolve({ data: {}, error: null })
  })

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.in     = vi.fn(() => chain)
    chain.order  = vi.fn(() => chain)
    chain.limit  = vi.fn(() => chain)
    // fetchAllRows() pages via .range(); a queued page shorter than the page
    // size ends the drain, so each paginated read still consumes exactly one
    // queued entry for its table.
    chain.range  = vi.fn(() => chain)
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

  return { from, upsertSpy, updateSpy, rpc, rpcSpy }
}

/** Finds the merge_integration_connection_metadata RPC call whose p_patch contains `key`. */
function findMetadataMergeCall(rpcSpy: ReturnType<typeof vi.fn>, key: string) {
  return rpcSpy.mock.calls.find(
    (c) =>
      c[0] === 'merge_integration_connection_metadata' &&
      (c[1] as { p_patch?: Record<string, unknown> }).p_patch?.[key] !== undefined,
  )
}

const PROPERTY: OwnerRezProperty = {
  id:            42,
  name:          'Lake House',
  bedrooms:      3,
  bathrooms:     2,
  max_occupancy: 6,
  living_area:   1500,
}

const BOOKING: OwnerRezBooking = {
  id:            900,
  arrival:       '2026-09-01',
  departure:     '2026-09-05',
  status:        'confirmed',
  type:          'booking',
  property_id:   42,
  listing_site:  'Direct',
  guest:         { first_name: 'Sam', last_name: 'Guest' },
  total_amount:  700,
  charges:       [{ type: 'rent', amount: 700, owner_amount: 700 }],
}

// Steps whose result the function dereferences later and must therefore be
// allowed to run for real, up through the point each test cares about.
// fetch-properties-to-enrich and find-properties-needing-checklist are made
// to return [] via the fixture data below (no active properties yet to
// enrich; the one property fetched already "has" a default checklist
// template) so their own downstream fan-out steps never fire and don't need
// separate mocking.
const GOLDEN_PATH_STEPS = [
  'fetch-properties',
  'fetch-properties-to-enrich',
  'find-properties-needing-checklist',
  'fetch-bookings',
  'update-last-synced',
  'generate-turnovers',
]

describe('ownerRezInitialSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  function baseMocks() {
    const mockClient = {
      getProperties:     vi.fn().mockResolvedValue([PROPERTY]),
      getPropertyDetail: vi.fn().mockResolvedValue(null),
      getListings:       vi.fn().mockResolvedValue([]),
      getBookings:       vi.fn().mockResolvedValue([]),
    }
    ;(OwnerRezApiClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return mockClient
    })
    return mockClient
  }

  it('resolves property_id, upserts properties/bookings on the org+external_id+external_source conflict target, and advances sync_cursor using the pre-fetch timestamp', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-20T09:00:00.000Z')
    vi.setSystemTime(start)

    const mockClient = baseMocks()
    mockClient.getBookings.mockImplementation(async () => {
      vi.setSystemTime(new Date(start.getTime() + 8000))
      return [BOOKING]
    })
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      properties: [
        { data: null, error: null },                                  // fetch-properties upsert
        { data: [], error: null },                                    // fetch-properties-to-enrich select (nothing to enrich)
        { data: [{ id: 'prop_1' }], error: null },                     // find-properties-needing-checklist: property lookup
        { data: [{ id: 'prop_1', external_id: '42' }], error: null }, // fetch-bookings: property lookup
      ],
      checklist_templates: [
        // prop_1 already has a default template -> propertiesNeedingChecklist filters it out to []
        { data: [{ property_id: 'prop_1' }], error: null },
      ],
      bookings: [
        { data: [{ id: 'booking_row_1', external_id: '900' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(GOLDEN_PATH_STEPS)

    const result = await invokeHandler(ownerRezInitialSync, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'properties',
      expect.arrayContaining([
        expect.objectContaining({
          org_id: 'org_1', external_id: '42', external_source: 'ownerrez', name: 'Lake House',
        }),
      ]),
      { onConflict: 'org_id,external_id,external_source' },
    )

    // The room counts are NOT in this upsert. patch-property-fields writes
    // them, and only where FieldStay holds null — naming them here re-asserted
    // OwnerRez's value on every re-run, undoing a PM's correction one step
    // before buildNullFillPatch declined to.
    const propertyRows = supabase.upsertSpy.mock.calls
      .filter((call: unknown[]) => call[0] === 'properties')
      .flatMap((call: unknown[]) => call[1] as Record<string, unknown>[])
    for (const row of propertyRows) {
      expect('bedrooms'   in row).toBe(false)
      expect('bathrooms'  in row).toBe(false)
      expect('max_guests' in row).toBe(false)
    }

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'bookings',
      expect.arrayContaining([expect.objectContaining({ external_id: '900', property_id: 'prop_1' })]),
      { onConflict: 'org_id,external_id,external_source' },
    )

    const cursorMergeCall = findMetadataMergeCall(supabase.rpcSpy, 'sync_cursor')
    expect(cursorMergeCall).toBeDefined()
    const patch = (cursorMergeCall?.[1] as { p_patch: Record<string, unknown> }).p_patch
    expect(patch.sync_cursor).toBe(start.toISOString())
    expect(patch.sync_cursor).not.toBe(new Date(start.getTime() + 8000).toISOString())

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(result).toEqual({ user_id: 'user_1', synced: true })

    vi.useRealTimers()
  })

  it('regression: patch-property-fields never overwrites a legitimate 0 bedroom/sqft value — only a real NULL gets filled', async () => {
    // bedrooms/square_footage previously used a falsy check (`!existing.bedrooms`),
    // which also matches a real 0 (e.g. a studio's bedroom count a PM
    // deliberately corrected) and would silently overwrite it with whatever
    // OwnerRez reports. bathrooms always used the correct `=== null` check;
    // bedrooms/square_footage must now match it.
    baseMocks()
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({
      properties: [
        { data: null, error: null }, // fetch-properties upsert
        {
          data: [{ id: 'prop_1', external_id: '42', bedrooms: 0, bathrooms: null, square_footage: null }],
          error: null,
        }, // patch-property-fields existingProps select — bedrooms is a real 0, not null
        { data: null, error: null }, // patch-property-fields update (bathrooms/sqft only)
        { data: [], error: null },   // fetch-properties-to-enrich select (nothing to enrich)
        { data: [{ id: 'prop_1' }], error: null }, // find-properties-needing-checklist: property lookup
        // fetch-bookings never queries properties here — getBookings() resolves
        // to [] (default baseMocks() stub), so the property-lookup block inside
        // fetch-bookings' `if (bookings.length)` guard never runs.
      ],
      checklist_templates: [{ data: [{ property_id: 'prop_1' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep([...GOLDEN_PATH_STEPS, 'patch-property-fields'])

    await invokeHandler(ownerRezInitialSync, {
      event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
      step,
      logger: makeLogger(),
    })

    const propertyPatchCall = supabase.updateSpy.mock.calls.find((c) => c[0] === 'properties')
    expect(propertyPatchCall).toBeDefined()
    const patchPayload = propertyPatchCall?.[1] as Record<string, unknown>
    // bedrooms was already 0 (a real, PM-set value) — must be left untouched.
    expect(patchPayload.bedrooms).toBeUndefined()
    // bathrooms/square_footage were genuinely null — still get filled from OwnerRez.
    expect(patchPayload.bathrooms).toBe(2)
    expect(patchPayload.square_footage).toBe(1500)
  })

  it('marks the connection revoked, notifies the PM, and throws NonRetriableError when OwnerRez reports a revoked token on the very first fetch', async () => {
    const mockClient = baseMocks()
    mockClient.getProperties.mockRejectedValue(new TokenRevokedError('user_1', 'provider_rejected'))

    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null }, // handle-sync-failure select
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep(['fetch-properties', 'handle-sync-failure'])

    await expect(
      invokeHandler(ownerRezInitialSync, {
        event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
        step,
        logger: makeLogger(),
      }),
    ).rejects.toThrow()

    expect(supabase.rpcSpy).toHaveBeenCalledWith(
      'merge_integration_connection_metadata',
      expect.objectContaining({ p_status: 'revoked' }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'integration.sync_failed',
        metadata: expect.objectContaining({ reason: 'token_revoked' }),
      }),
    )
    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-connection-error',
      expect.objectContaining({
        name: 'integration/connection.error',
        data: expect.objectContaining({ user_id: 'user_1', org_id: 'org_1', provider_id: 'ownerrez' }),
      }),
    )
  })

  it('throws (rather than silently skipping) when the property lookup fails during fetch-bookings, and marks the connection status "error" — not "revoked" — for this non-auth failure', async () => {
    const mockClient = baseMocks()
    mockClient.getBookings.mockResolvedValue([BOOKING])

    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null }, // handle-sync-failure select
      ],
      properties: [
        { data: null, error: null },               // fetch-properties upsert
        { data: [], error: null },                  // fetch-properties-to-enrich select
        { data: [{ id: 'prop_1' }], error: null },  // find-properties-needing-checklist: property lookup
        { data: null, error: { message: 'db timeout' } }, // fetch-bookings: property lookup FAILS
      ],
      checklist_templates: [{ data: [{ property_id: 'prop_1' }], error: null }],
      org_milestones:      [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeAllowlistStep([
      'fetch-properties',
      'fetch-properties-to-enrich',
      'find-properties-needing-checklist',
      'fetch-bookings',
      'handle-sync-failure',
    ])

    await expect(
      invokeHandler(ownerRezInitialSync, {
        event:  { data: { user_id: 'user_1', org_id: 'org_1' } },
        step,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/Property lookup failed for org org_1/)

    expect(supabase.upsertSpy).not.toHaveBeenCalledWith('bookings', expect.anything(), expect.anything())
    expect(supabase.rpcSpy).toHaveBeenCalledWith(
      'merge_integration_connection_metadata',
      expect.objectContaining({ p_status: 'error' }),
    )

    const auditCall = (logAuditEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'integration.sync_failed',
    )
    expect(auditCall).toBeDefined()
    expect((auditCall?.[0] as { metadata: Record<string, unknown> }).metadata.reason).toBeUndefined()
  })

  // ── Coverage added 2026-08-12, ahead of refactoring fetch-bookings ───────
  //
  // The step is 100 lines doing six things and carries a cognitive-complexity
  // warning, but the reason to touch it is SCALE, not the metric: it fetches
  // every booking for every property in ONE call, returns a
  // bookingsToPostRevenue array that grows with the portfolio (and is
  // serialized as step output for replay), and re-runs the whole API fetch on
  // any retry. These paths were the untested ones, so they are the ones a
  // refactor could break silently.

  /** A connection whose OwnerRez account reports no properties. */
  function noPropertiesMocks() {
    const mockClient = baseMocks()
    mockClient.getProperties.mockResolvedValue([])
    return mockClient
  }

  it('takes the zero-properties path without calling the bookings API at all', async () => {
    // Calling getBookings with neither property_ids nor since_utc is the shape
    // OwnerRez rejects, and burning a rate-limited request to learn that is
    // worse than not asking.
    const mockClient = noPropertiesMocks()
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(ownerRezInitialSync, {
      event:  { data: { user_id: 'u1', org_id: 'o1' } },
      step:   makeAllowlistStep(GOLDEN_PATH_STEPS),
      logger: makeLogger(),
    })

    expect(mockClient.getBookings).not.toHaveBeenCalled()
  })

  it('still records bookings_found = 0 on that path', async () => {
    // writeSyncCount is what the connection card reads. Skipping it on the
    // empty path would leave a previous run's number on screen.
    noPropertiesMocks()
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(ownerRezInitialSync, {
      event:  { data: { user_id: 'u1', org_id: 'o1' } },
      step:   makeAllowlistStep(GOLDEN_PATH_STEPS),
      logger: makeLogger(),
    })

    expect(findMetadataMergeCall(supabase.rpcSpy, 'bookings_found')).toBeDefined()
  })

  it('does NOT fail the sync when the bookings_found write fails', async () => {
    // writeSyncCount is a display counter. An outage writing it must not cost
    // the customer their entire initial sync — the bookings are the point.
    // This is the one deliberately swallowed error in the step, so a refactor
    // that "tidies" the try/catch away turns a cosmetic failure into a fatal
    // one, silently. That is exactly what this test exists to catch.
    noPropertiesMocks()
    const supabase = makeSupabase({})
    // Scoped to the bookings_found patch ONLY. Failing every metadata merge
    // also breaks update-last-synced, which is fatal BY DESIGN — losing the
    // sync cursor means the next incremental run re-pulls from the beginning.
    // The distinction between the two is the thing under test.
    supabase.rpc.mockImplementation((fnName: string, args: unknown) => {
      const patch = (args as { p_patch?: Record<string, unknown> })?.p_patch
      if (fnName === 'merge_integration_connection_metadata' && patch && 'bookings_found' in patch) {
        return Promise.reject(new Error('metadata write unavailable'))
      }
      return Promise.resolve({ data: {}, error: null })
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(ownerRezInitialSync, {
      event:  { data: { user_id: 'u1', org_id: 'o1' } },
      step:   makeAllowlistStep(GOLDEN_PATH_STEPS),
      logger: makeLogger(),
    })).resolves.not.toThrow()
  })
})
