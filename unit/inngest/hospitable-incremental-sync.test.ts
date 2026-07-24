import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospitableFetch: vi.fn(),
  hospitablePropertyToNormalized: vi.fn(),
  hospitableReservationToNormalized: vi.fn(),
  hospFetchReservationMessages: vi.fn(),
}))
vi.mock('@/lib/properties/upsert-normalized', () => ({
  upsertNormalizedProperties: vi.fn(),
}))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty: vi.fn(),
  cancelTurnoversForBooking:    vi.fn(),
}))
vi.mock('@/lib/guidebook/sync', () => ({
  createGuidebookPropertyConfigsForProperties: vi.fn(),
  syncGuidebookConfigsFromProperty:            vi.fn(),
}))
vi.mock('@/lib/asset-discovery/seed-from-amenities', () => ({
  seedPresentAssetsFromAmenities:       vi.fn(),
  seedAbsentOptionalAssetsFromAmenities: vi.fn(),
}))

import { hospIncrementalSync } from '@/lib/inngest/functions/hospitable/incremental-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import {
  hospitableFetch,
  hospitablePropertyToNormalized,
  hospitableReservationToNormalized,
} from '@/lib/integrations/providers/hospitable'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { invokeHandler } from './test-helpers'

// This function fans out into four disjoint entity-type branches
// (reservation/property/review/message), each of which does its own
// org/token resolution, fetches from the live Hospitable API, and upserts
// into a different table with its own idempotency conflict target. Rather
// than an allowlist-single-step stub (which doesn't work here — later
// steps depend on real data returned by earlier steps, e.g. upsert-booking
// needs the reservation payload fetch-reservation actually returned), this
// stub executes every step for real and relies on mocking every external
// module boundary (Supabase, the Hospitable HTTP client, the pure
// normalizers, turnover generation, guidebook/asset-discovery seeding).
// This exercises the function's own control flow and query shapes exactly
// as it runs in production, without hitting a real DB or network.
function makeRunAllStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

// HandlerContext's logger type only declares info/error, but the real
// function also calls logger.warn on a couple of expected, non-error
// paths (e.g. an unrecognized provider_id, an unhandled entity_type). A
// plain object literal at the call site would fail TS's excess-property
// check for the extra `warn` key — returning it from a function avoids
// that check entirely while still giving the real code a callable no-op.
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: unknown[] }

// Queue-based Supabase mock (same pattern as
// unit/owner-portal/load-owner-portal-data.test.ts): each `.from(table)`
// call consumes the next queued response for that table in call order.
// `calls` records every filter/write invocation so tests can assert on the
// exact idempotency conflict target passed to `.upsert()`.
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
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)

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

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const NORMALIZED_RESERVATION_BASE = {
  external_id:          'res_1',
  property_external_id: 'hosp_prop_1',
  checkin_time:         '16:00',
  checkout_time:        '10:00',
  status:                'confirmed',
  guest_name:            'Jane Guest',
  guest_email:           'jane@example.com',
  source:                'airbnb',
  is_block:              false,
  stay_type:             'guest_stay' as const,
  actual_total_amount:   400,
}

const RAW_RESERVATION = {
  id:         'res_1',
  properties: [{ id: 'hosp_prop_1', name: 'Lakehouse', public_name: 'Lakehouse' }],
}

describe('hospIncrementalSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('upserts a booking with the idempotent conflict target and regenerates turnovers when dates changed', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: { org_id: 'org_1' }, error: null },                                    // resolve-org-and-token: booking already exists
        { data: { checkin_date: '2026-08-01', checkout_date: '2026-08-05' }, error: null }, // upsert-booking: existing dates (different from new)
        { data: { id: 'booking_1' }, error: null },                                     // upsert-booking: upserted row
      ],
      integration_connections: [{ data: { org_id: 'org_1' }, error: null }],            // resolve-org-and-token: org_1's connection still active
      organization_members: [{ data: { user_id: 'user_1' }, error: null }],
      properties:           [{ data: { id: 'prop_1' }, error: null }],
      turnovers: [{
        data: [{
          id: 'to_1', property_id: 'prop_1',
          checkout_datetime: '2026-08-05T10:00:00Z', checkin_datetime: '2026-08-10T16:00:00Z',
          window_minutes: 300,
        }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ data: RAW_RESERVATION }))
    ;(hospitableReservationToNormalized as ReturnType<typeof vi.fn>).mockReturnValue({
      ...NORMALIZED_RESERVATION_BASE,
      checkin_date:  '2026-08-10',
      checkout_date: '2026-08-14',
    })
    ;(generateTurnoversForProperty as ReturnType<typeof vi.fn>).mockResolvedValue(['to_1'])

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'reservation.updated', entity_type: 'reservation', entity_id: 'res_1', triggers: ['dates_changed'] } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'upserted', entity_id: 'res_1', datesChanged: true })

    const bookingUpsert = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'upsert')
    expect(bookingUpsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    expect(bookingUpsert?.args[0]).toMatchObject({
      org_id: 'org_1', property_id: 'prop_1', external_id: 'res_1', external_source: 'hospitable',
      checkin_date: '2026-08-10', checkout_date: '2026-08-14',
    })

    expect(generateTurnoversForProperty).toHaveBeenCalledWith('prop_1', 'org_1', supabase)
    expect(step.sendEvent).toHaveBeenCalledWith(
      'fire-turnover-events',
      expect.arrayContaining([expect.objectContaining({ name: 'turnover/created', data: expect.objectContaining({ turnover_id: 'to_1' }) })]),
    )
  })

  it('skips turnover regeneration when the reservation dates are unchanged', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: { org_id: 'org_1' }, error: null },
        { data: { checkin_date: '2026-08-10', checkout_date: '2026-08-14' }, error: null }, // same as normalized below
        { data: { id: 'booking_1' }, error: null },
      ],
      integration_connections: [{ data: { org_id: 'org_1' }, error: null }],
      organization_members: [{ data: { user_id: 'user_1' }, error: null }],
      properties:           [{ data: { id: 'prop_1' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ data: RAW_RESERVATION }))
    ;(hospitableReservationToNormalized as ReturnType<typeof vi.fn>).mockReturnValue({
      ...NORMALIZED_RESERVATION_BASE,
      checkin_date:  '2026-08-10',
      checkout_date: '2026-08-14',
    })

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'reservation.updated', entity_type: 'reservation', entity_id: 'res_1', triggers: ['status_changed'] } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'upserted', entity_id: 'res_1', datesChanged: false })
    expect(generateTurnoversForProperty).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalledWith('fire-turnover-events', expect.anything())
  })

  it('routes a property entity to the property fetch/upsert branch, never touching reservation logic', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: null, error: null }, // resolve-org-and-token: no existing property row → new property
      ],
      integration_connections: [
        { data: { user_id: 'user_1', org_id: 'org_1' }, error: null },
      ],
      org_milestones: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ data: { id: 'hosp_prop_2', name: 'Cabin' } })
    )
    ;(hospitablePropertyToNormalized as ReturnType<typeof vi.fn>).mockReturnValue({ external_id: 'hosp_prop_2', name: 'Cabin' })
    ;(upsertNormalizedProperties as ReturnType<typeof vi.fn>).mockResolvedValue({ hosp_prop_2: 'prop_uuid_2' })

    const { seedPresentAssetsFromAmenities, seedAbsentOptionalAssetsFromAmenities } =
      await import('@/lib/asset-discovery/seed-from-amenities')
    ;(seedPresentAssetsFromAmenities as ReturnType<typeof vi.fn>).mockResolvedValue({ seeded: false, total: 1 })
    ;(seedAbsentOptionalAssetsFromAmenities as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'property.updated', entity_type: 'property', entity_id: 'hosp_prop_2' } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'synced', entity_id: 'hosp_prop_2' })
    expect(upsertNormalizedProperties).toHaveBeenCalledWith('org_1', 'hospitable', [{ external_id: 'hosp_prop_2', name: 'Cabin' }])
    // Routing proof: the reservation-only normalizer must never be invoked for a property webhook
    expect(hospitableReservationToNormalized).not.toHaveBeenCalled()
    expect(generateTurnoversForProperty).not.toHaveBeenCalled()
  })

  it('routes a review entity to the review upsert branch and fires repuguard batch generation', async () => {
    const supabase = makeSupabase({
      reviews: [
        { data: null, error: null },              // resolve-org-and-token: new review, fast path misses
        { data: { id: 'review_1' }, error: null }, // fetch-and-upsert-review: upserted row
      ],
      integration_connections: [
        { data: { user_id: 'user_1', org_id: 'org_1' }, error: null },
      ],
      properties: [{ data: { id: 'prop_1' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hospitableFetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({
      data: {
        public:       { rating: 5, review: 'Great stay' },
        guest:        { first_name: 'Jane', last_name: 'G' },
        property:     { id: 'hosp_prop_1' },
        reviewed_at:  '2026-07-01',
      },
    }))

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'review.created', entity_type: 'review', entity_id: 'rev_1' } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'synced', entity_id: 'rev_1' })

    const reviewUpsert = supabase.calls.find((c) => c.table === 'reviews' && c.method === 'upsert')
    expect(reviewUpsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    expect(reviewUpsert?.args[0]).toMatchObject({
      org_id: 'org_1', external_id: 'rev_1', rating: 5, review_text: 'Great stay', guest_name: 'Jane G',
    })

    expect(step.sendEvent).toHaveBeenCalledWith('trigger-repuguard', {
      name: 'repuguard/batch_generate.requested',
      data: { org_id: 'org_1', requested_by: 'hospitable-webhook' },
    })
    // Routing proof: property/reservation normalizers never touched for a review webhook
    expect(hospitablePropertyToNormalized).not.toHaveBeenCalled()
    expect(hospitableReservationToNormalized).not.toHaveBeenCalled()
  })

  it('skips cleanly (no throw, no retry) instead of crashing when no active Hospitable connection can be found for a brand-new reservation', async () => {
    const supabase = makeSupabase({
      bookings:                 [{ data: null, error: null }], // new reservation, no existing booking to resolve org from
      integration_connections:  [{ data: null, error: null }], // no active connection either
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'reservation.created', entity_type: 'reservation', entity_id: 'res_2' } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'no_active_connection', entity_id: 'res_2' })
    // Never got far enough to fetch a token or hit the Hospitable API
    expect(getValidHospitableToken).not.toHaveBeenCalled()
    expect(hospitableFetch).not.toHaveBeenCalled()
  })

  it('skips cleanly instead of throwing when an existing booking resolves to an org whose Hospitable connection has since been disconnected', async () => {
    // Mirrors the real production bug (SENTRY-CRAZY-CUSHION-9): Hospitable
    // keeps sending webhooks for an org's existing bookings long after the
    // PM disconnected in Settings — disconnectIntegration() never touches
    // `bookings`, so resolve-org-and-token still finds org_1 here, but
    // org_1's integration_connections row is no longer 'active'.
    const supabase = makeSupabase({
      bookings:                [{ data: { org_id: 'org_1' }, error: null }],
      integration_connections: [{ data: null, error: null }], // org_1 has no active connection anymore
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeRunAllStep()
    const result = await invokeHandler(hospIncrementalSync, {
      event: { data: { provider_id: 'hospitable', event_type: 'reservation.changed', entity_type: 'reservation', entity_id: 'res_3', triggers: ['status_changed'] } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'no_active_connection', entity_id: 'res_3' })
    expect(getValidHospitableToken).not.toHaveBeenCalled()
    expect(hospitableFetch).not.toHaveBeenCalled()
  })
})
