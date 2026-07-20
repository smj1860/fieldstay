import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospFetchProperties:               vi.fn(),
  hospFetchReservations:             vi.fn(),
  hospFetchTeammates:                vi.fn(),
  hospitablePropertyToNormalized:    vi.fn(),
  hospitableReservationToNormalized: vi.fn(),
  hospitableTeammatesToCrewRows:     vi.fn(),
}))
vi.mock('@/lib/properties/upsert-normalized', () => ({
  upsertNormalizedProperties: vi.fn(),
}))
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
  fetchOrgRoomTemplateData:       vi.fn(),
}))
vi.mock('@/lib/checklists/seed-default-room-templates', () => ({
  seedDefaultRoomTemplatesIfNeeded: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
}))
vi.mock('@/lib/guidebook/sync', () => ({
  ensureGuidebookConfiguration:                vi.fn(),
  createGuidebookPropertyConfigsForProperties: vi.fn(),
  syncGuidebookConfigsFromProperty:            vi.fn(),
}))
vi.mock('@/lib/asset-discovery/seed-from-amenities', () => ({
  seedPresentAssetsFromAmenities:        vi.fn(),
  seedAbsentOptionalAssetsFromAmenities: vi.fn(),
}))

import { hospInitialSync } from '@/lib/inngest/functions/hospitable/initial-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import {
  hospFetchProperties,
  hospFetchReservations,
  hospFetchTeammates,
  hospitablePropertyToNormalized,
  hospitableReservationToNormalized,
  hospitableTeammatesToCrewRows,
} from '@/lib/integrations/providers/hospitable'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { fetchOrgRoomTemplateData } from '@/lib/checklists/apply-master-template'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'
import { invokeHandler } from './test-helpers'

// Every module this file imports (Vault, the Hospitable HTTP client + pure
// normalizers, checklist/guidebook/asset-discovery seeding, turnover
// generation) is mocked at the module boundary, so running every step.run()
// for real only ever touches Supabase directly for the handful of steps
// that do so inline (crew_members/bookings upserts, the
// integration_connections metadata read/write). This lets the test drive
// the function's real control flow — including the property/reservation
// matching logic and the revenue-eligibility filter — without needing to
// fake out every dependency's internal query shape.
function makeRunAllStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

// HandlerContext's logger type only declares info/error, but the real
// function also calls logger.warn on an expected, non-error path (a
// reservation whose Hospitable property isn't yet synced to FieldStay).
// Returning the logger from a function — rather than a literal at the call
// site — avoids TS's excess-property check on the extra `warn` key while
// still giving the real code a callable no-op.
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: unknown[] }

function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const EVENT_DATA = { user_id: 'user_1', org_id: 'org_1', external_user_id: 'ext_1' }

describe('hospInitialSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Defaults so every non-focal step is a harmless no-op unless a test overrides it.
    ;(hospFetchTeammates as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(hospitableTeammatesToCrewRows as ReturnType<typeof vi.fn>).mockReturnValue([])
    ;(fetchOrgRoomTemplateData as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(seedPresentAssetsFromAmenities as ReturnType<typeof vi.fn>).mockResolvedValue({ seeded: 0, total: 0 })
    ;(seedAbsentOptionalAssetsFromAmenities as ReturnType<typeof vi.fn>).mockResolvedValue({ seeded: 0, total: 0 })
  })

  it('upserts bookings idempotently and fires booking/confirmed only for confirmed guest stays with a matched property', async () => {
    const supabase = makeSupabase({
      bookings: [
        { error: null },                                                                                       // fetch-and-upsert-reservations: upsert ack
        { data: [{ id: 'booking_1', property_id: 'prop_uuid_1', actual_total_amount: 400 }], error: null },    // fetch-bookings-for-revenue
      ],
      integration_connections: [
        { data: { metadata: {} }, error: null }, // mark-complete: read existing metadata
        { error: null },                          // mark-complete: write metadata
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')

    ;(hospFetchProperties as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'hosp_p1', name: 'Lakehouse' }])
    ;(hospitablePropertyToNormalized as ReturnType<typeof vi.fn>).mockImplementation(
      (p: { id: string; name: string }) => ({ external_id: p.id, name: p.name })
    )
    ;(upsertNormalizedProperties as ReturnType<typeof vi.fn>).mockResolvedValue({ hosp_p1: 'prop_uuid_1' })

    // Matched + revenue-eligible; matched but owner_stay (excluded from revenue);
    // unmatched property (excluded from bookings entirely).
    const rawReservations = [
      { id: 'res_1', __normalized: { external_id: 'res_1', property_external_id: 'hosp_p1', checkin_date: '2026-08-01', checkout_date: '2026-08-05', checkin_time: '16:00', checkout_time: '10:00', status: 'confirmed', guest_name: 'Jane', guest_email: 'jane@x.com', source: 'airbnb', is_block: false, stay_type: 'guest_stay', actual_total_amount: 400 } },
      { id: 'res_2', __normalized: { external_id: 'res_2', property_external_id: 'hosp_p1', checkin_date: '2026-08-06', checkout_date: '2026-08-08', checkin_time: '16:00', checkout_time: '10:00', status: 'confirmed', guest_name: 'Owner', guest_email: null, source: 'airbnb', is_block: false, stay_type: 'owner_stay', actual_total_amount: null } },
      { id: 'res_3', __normalized: { external_id: 'res_3', property_external_id: 'hosp_unknown', checkin_date: '2026-08-10', checkout_date: '2026-08-12', checkin_time: '16:00', checkout_time: '10:00', status: 'confirmed', guest_name: 'Nowhere', guest_email: null, source: 'airbnb', is_block: false, stay_type: 'guest_stay', actual_total_amount: 200 } },
    ]
    ;(hospFetchReservations as ReturnType<typeof vi.fn>).mockResolvedValue(rawReservations)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(hospitableReservationToNormalized as ReturnType<typeof vi.fn>).mockImplementation((res: any) => res.__normalized)

    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const step = makeRunAllStep()
    const result = await invokeHandler(hospInitialSync, {
      event:  { data: EVENT_DATA },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ properties: 1, crew_members: 0, reservations: 2 })

    const bookingUpsert = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'upsert')
    expect(bookingUpsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookingRows = bookingUpsert?.args[0] as any[]
    expect(bookingRows).toHaveLength(2)
    expect(bookingRows.map((r) => r.external_id).sort()).toEqual(['res_1', 'res_2'])
    // Reservation for an unmatched property must never reach the upsert
    expect(bookingRows.some((r) => r.external_id === 'res_3')).toBe(false)

    // Only the confirmed guest_stay reservation is revenue-eligible
    const revenueSelect = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'in')
    expect(revenueSelect?.args).toEqual(['external_id', ['res_1']])

    expect(step.sendEvent).toHaveBeenCalledWith('fire-booking-confirmed-events', [
      {
        name: 'booking/confirmed',
        data: { booking_id: 'booking_1', property_id: 'prop_uuid_1', org_id: 'org_1', source: 'hospitable', actual_total_amount: 400 },
      },
    ])
  })

  it('marks the connection as errored with a translated message when the Vault token is missing, instead of failing silently', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        { error: null },                          // handle-failure: status update
        { data: { metadata: {} }, error: null },  // handle-failure -> updateConnectionMeta: read
        { error: null },                          // handle-failure -> updateConnectionMeta: write
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const step = makeRunAllStep()

    await expect(invokeHandler(hospInitialSync, {
      event:  { data: EVENT_DATA },
      step,
      logger: makeLogger(),
    })).rejects.toThrow('No Hospitable token found')

    const statusUpdate = supabase.calls.find(
      (c) => c.table === 'integration_connections' && c.method === 'update' && (c.args[0] as Record<string, unknown>).status === 'error'
    )
    expect(statusUpdate).toBeDefined()

    const metaUpdate = supabase.calls.find(
      (c) => c.table === 'integration_connections' && c.method === 'update' && 'metadata' in (c.args[0] as Record<string, unknown>)
    )
    const metadata = (metaUpdate?.args[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.last_sync_status).toBe('error')
    expect(typeof metadata.last_sync_error).toBe('string')

    // Never got past reading the token — no properties/reservations fetched
    expect(hospFetchProperties).not.toHaveBeenCalled()
  })
})
