import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hostaway', () => ({
  hostawayFetchListings:     vi.fn(),
  hostawayFetchReservations: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
}))

import { hostawayInitialSync } from '@/lib/inngest/functions/hostaway/initial-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { hostawayFetchListings, hostawayFetchReservations } from '@/lib/integrations/providers/hostaway'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { invokeHandler } from './test-helpers'

// Vault and the Hostaway HTTP client are mocked at the module boundary;
// every other read/write in this function goes directly through Supabase
// (there's no separate normalizer module to mock the way Hospitable has),
// so the step stub below runs every step.run() for real and the Supabase
// mock queue drives the rest.
function makeRunAllStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

// HandlerContext's logger type only declares info/error; returning it from
// a function (rather than a literal at the call site) sidesteps TS's
// excess-property check so this stub can still safely absorb a stray
// logger.warn call from the real function if one is ever added.
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

const EVENT_DATA = { user_id: 'user_1', org_id: 'org_1', provider_id: 'hostaway', full_sync: true }

function listing(id: number) {
  return {
    id, name: `Listing ${id}`, externalListingName: `Listing ${id}`,
    address: null, city: null, state: null, zipcode: null, lat: null, lng: null,
    bedrooms: 2, bathrooms: 1, maxGuests: 4,
  }
}

describe('hostawayInitialSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('upserts properties and bookings with the idempotent conflict target, regenerating turnovers only for touched properties', async () => {
    const supabase = makeSupabase({
      properties: [
        { error: null }, // fetch-and-upsert-properties: upsert ack
        {
          data: [
            { id: 'prop_uuid_101', external_id: '101' },
            { id: 'prop_uuid_102', external_id: '102' },
            { id: 'prop_uuid_103', external_id: '103' },
          ],
          error: null,
        }, // fetch-and-upsert-properties: re-select
      ],
      bookings: [{ error: null }], // fetch-and-upsert-bookings: upsert ack
      integration_connections: [
        { data: { metadata: {} }, error: null }, { error: null }, // updateConnectionMetadata (properties_found)
        { data: { metadata: {} }, error: null }, { error: null }, // updateConnectionMetadata (bookings_found)
        { data: { metadata: {} }, error: null }, { error: null }, // mark-complete
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hostawayFetchListings as ReturnType<typeof vi.fn>).mockResolvedValue([listing(101), listing(102), listing(103)])
    ;(hostawayFetchReservations as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 5001, listingId: 101, guestName: 'Jane', guestEmail: 'jane@x.com', arrivalDate: '2026-08-01', departureDate: '2026-08-05', status: 'confirmed', channelName: 'Airbnb' },
      { id: 5002, listingId: 999, guestName: 'Nowhere', guestEmail: null, arrivalDate: '2026-08-02', departureDate: '2026-08-04', status: 'confirmed', channelName: 'Vrbo' }, // unmatched listing — must be skipped
      { id: 5003, listingId: 102, guestName: 'Bob', guestEmail: null, arrivalDate: '2026-08-06', departureDate: '2026-08-09', status: 'new', channelName: 'direct' },
    ])
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const step = makeRunAllStep()
    const result = await invokeHandler(hostawayInitialSync, {
      event:  { data: EVENT_DATA },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ properties: 3, reservations: 3, turnovers_for: 2 })

    const propertiesUpsert = supabase.calls.find((c) => c.table === 'properties' && c.method === 'upsert')
    expect(propertiesUpsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((propertiesUpsert?.args[0] as any[]).map((r) => r.external_id).sort()).toEqual(['101', '102', '103'])

    const bookingsUpsert = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'upsert')
    expect(bookingsUpsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookingRows = bookingsUpsert?.args[0] as any[]
    expect(bookingRows).toHaveLength(2)
    expect(bookingRows.map((r) => r.external_id).sort()).toEqual(['5001', '5003'])
    expect(bookingRows.find((r) => r.external_id === '5001')?.status).toBe('confirmed')
    expect(bookingRows.find((r) => r.external_id === '5003')?.status).toBe('tentative') // 'new' maps to tentative

    // Turnovers are only regenerated for properties that actually received a
    // booking (101, 102) — property 103 was synced but never touched.
    expect(generateTurnoversForProperty).toHaveBeenCalledTimes(2)
    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_uuid_101', 'org_1', supabase)
    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_uuid_102', 'org_1', supabase)
    expect(generateTurnoversForProperty).not.toHaveBeenCalledWith('prop_uuid_103', 'org_1', supabase)
  })

  it('completes cleanly with no writes when the org has no listings or reservations yet', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        { data: { metadata: {} }, error: null }, { error: null }, // properties_found
        { data: { metadata: {} }, error: null }, { error: null }, // bookings_found
        { data: { metadata: {} }, error: null }, { error: null }, // mark-complete
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hostawayFetchListings as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(hostawayFetchReservations as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const step = makeRunAllStep()
    const result = await invokeHandler(hostawayInitialSync, {
      event:  { data: EVENT_DATA },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ properties: 0, reservations: 0, turnovers_for: 0 })
    expect(supabase.calls.some((c) => c.table === 'properties')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'bookings')).toBe(false)
    expect(generateTurnoversForProperty).not.toHaveBeenCalled()

    const lastMetaUpdate = [...supabase.calls].reverse().find(
      (c) => c.table === 'integration_connections' && c.method === 'update'
    )
    const metadata = (lastMetaUpdate?.args[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.last_sync_status).toBe('success')
    expect(metadata.last_sync_count).toBe(0)
  })
})
