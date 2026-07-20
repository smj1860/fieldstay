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

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.in     = vi.fn(() => chain)
    chain.order  = vi.fn(() => chain)
    chain.limit  = vi.fn(() => chain)
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

  return { from, upsertSpy, updateSpy }
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
  channel_name:  'Direct',
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
      integration_connections: [
        { data: { metadata: {} }, error: null }, // fetch-properties writeSyncCount select
        { data: null, error: null },             // fetch-properties writeSyncCount update
        { data: { metadata: {} }, error: null }, // fetch-bookings writeSyncCount select
        { data: null, error: null },             // fetch-bookings writeSyncCount update
        { data: { metadata: {} }, error: null }, // update-last-synced select
        { data: null, error: null },             // update-last-synced update (the cursor write)
      ],
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
          org_id: 'org_1', external_id: '42', external_source: 'ownerrez', name: 'Lake House', max_guests: 6,
        }),
      ]),
      { onConflict: 'org_id,external_id,external_source' },
    )

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'bookings',
      expect.arrayContaining([expect.objectContaining({ external_id: '900', property_id: 'prop_1' })]),
      { onConflict: 'org_id,external_id,external_source' },
    )

    const cursorUpdate = supabase.updateSpy.mock.calls
      .filter((c) => c[0] === 'integration_connections')
      .pop()
    expect(cursorUpdate).toBeDefined()
    const metadata = (cursorUpdate?.[1] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.sync_cursor).toBe(start.toISOString())
    expect(metadata.sync_cursor).not.toBe(new Date(start.getTime() + 8000).toISOString())

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(result).toEqual({ user_id: 'user_1', synced: true })

    vi.useRealTimers()
  })

  it('marks the connection revoked, notifies the PM, and throws NonRetriableError when OwnerRez reports a revoked token on the very first fetch', async () => {
    const mockClient = baseMocks()
    mockClient.getProperties.mockRejectedValue(new TokenRevokedError('user_1'))

    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1', metadata: {} }, error: null }, // handle-sync-failure select
        { data: null, error: null },                            // handle-sync-failure update
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

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'integration_connections',
      expect.objectContaining({ status: 'revoked' }),
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
        { data: { metadata: {} }, error: null },                // fetch-properties writeSyncCount select
        { data: null, error: null },                             // fetch-properties writeSyncCount update
        { data: { id: 'conn_1', metadata: {} }, error: null },   // handle-sync-failure select
        { data: null, error: null },                             // handle-sync-failure update
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
    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'integration_connections',
      expect.objectContaining({ status: 'error' }),
    )

    const auditCall = (logAuditEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'integration.sync_failed',
    )
    expect(auditCall).toBeDefined()
    expect((auditCall?.[0] as { metadata: Record<string, unknown> }).metadata.reason).toBeUndefined()
  })
})
