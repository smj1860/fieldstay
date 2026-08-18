import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// ============================================================================
// Regression tests for the 2026-08-17 production incident.
//
// Two Sentry errors, both "[Inngest] fieldstay-hospitable-incremental-sync
// exhausted all retries":
//
//   1. Hospitable GET /reservations/{uuid}/messages failed (401):
//      {"message":"Unauthenticated."}
//   2. Rate limited — retry after 2s
//
// and Hospitable's own partner API log for the same reservation in the same
// hour showed 200 / 429 / 200 across 48 seconds — i.e. we were hammering one
// reservation hard enough to trip a per-entity limit, while a 401 that could
// never succeed was being retried five times.
//
// The two were one mistake: the retry policy was deciding things the error
// type already knew. A 401 is terminal and must not retry at all; a 429 comes
// with a Retry-After the caller must honour INSTEAD of Inngest's generic
// exponential backoff — which re-runs the whole step, and for the resolution
// step that means re-probing every candidate connection, so a rate-limited
// retry issued MORE provider calls than the attempt that failed.
//
// Each test below is written to FAIL against the pre-fix code. The comments
// name which behaviour was broken so a future change that reintroduces it
// gets told exactly what it broke, rather than just seeing a red assertion.
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/integrations/providers/hospitable-owner', () => ({
  resolveHospitableOwner: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospitableFetch:                   vi.fn(),
  hospitablePropertyToNormalized:    vi.fn(),
  hospitableReservationToNormalized: vi.fn(),
  hospFetchReservationMessages:      vi.fn(),
}))
vi.mock('@/lib/properties/upsert-normalized', () => ({ upsertNormalizedProperties: vi.fn() }))
vi.mock('@/lib/turnovers/generator', () => ({
  generateTurnoversForProperty:   vi.fn(),
  cancelTurnoversForBooking:      vi.fn().mockResolvedValue([]),
  notifyCrewOfCancelledTurnovers: vi.fn(),
}))
vi.mock('@/lib/guidebook/sync', () => ({
  createGuidebookPropertyConfigsForProperties: vi.fn(),
  syncGuidebookConfigsFromProperty:            vi.fn(),
}))
vi.mock('@/lib/asset-discovery/seed-from-amenities', () => ({
  seedPresentAssetsFromAmenities:        vi.fn(),
  seedAbsentOptionalAssetsFromAmenities: vi.fn(),
}))

import { hospIncrementalSync } from '@/lib/inngest/functions/hospitable/incremental-sync'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveHospitableOwner } from '@/lib/integrations/providers/hospitable-owner'
import { hospFetchReservationMessages } from '@/lib/integrations/providers/hospitable'
import { RateLimitError, ProviderAuthError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

/** Runs every step body for real; records sleeps so they can be asserted. */
function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Minimal Supabase stub — the message branch only reads `bookings` then upserts. */
function makeSupabase() {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select      = (...a: unknown[]) => record('select', a)
    chain.upsert      = (...a: unknown[]) => record('upsert', a)
    chain.eq          = (...a: unknown[]) => record('eq', a)
    chain.maybeSingle = () => Promise.resolve({ data: { id: 'booking_1' }, error: null })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve)
    return chain
  })
  return { from, calls }
}

const MESSAGE_EVENT = {
  provider_id: 'hospitable',
  event_type:  'message.created',
  entity_type: 'message',
  entity_id:   'db0dca2d-1a35-42fa-84ad-606bb1b0c021', // the reservation from the incident
}

function runMessageSync(step: ReturnType<typeof makeStep>) {
  return invokeHandler(hospIncrementalSync, {
    event:  { data: MESSAGE_EVENT },
    step,
    logger: makeLogger(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(createServiceClient).mockReturnValue(makeSupabase())
  mock(resolveHospitableOwner).mockResolvedValue({
    orgId: 'org_1', userId: 'user_1', token: 'token_abc',
  })
})

describe('hospIncrementalSync — terminal auth failures', () => {
  it('fails NON-retriably on a 401 from the messages endpoint', async () => {
    // THE INCIDENT. A 401 was thrown as a plain Error, so Inngest's retries: 5
    // applied and the function burned five doomed calls before reporting
    // "exhausted all retries". The TYPE is the assertion: a plain Error
    // satisfies any message matcher while still being fully retriable, which
    // is exactly the distinction that was missing.
    mock(hospFetchReservationMessages).mockRejectedValue(
      new ProviderAuthError('Hospitable', 401, 'GET /reservations/{id}/messages', '{"message":"Unauthenticated."}'),
    )

    await expect(runMessageSync(makeStep())).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('does not re-call the provider after a terminal auth failure', async () => {
    // The rate-limit path retries once after sleeping. A terminal auth failure
    // must NOT borrow that second attempt — retrying a missing scope is the
    // amplification this whole change exists to remove.
    mock(hospFetchReservationMessages).mockRejectedValue(
      new ProviderAuthError('Hospitable', 403, 'GET /reservations/{id}/messages'),
    )

    const step = makeStep()
    await expect(runMessageSync(step)).rejects.toBeInstanceOf(NonRetriableError)

    expect(hospFetchReservationMessages).toHaveBeenCalledTimes(1)
    expect(step.sleep).not.toHaveBeenCalled()
  })
})

describe('hospIncrementalSync — rate limiting', () => {
  it("sleeps for the provider's own Retry-After, then retries once", async () => {
    // Pre-fix there was NO RateLimitError handling and NO step.sleep anywhere
    // in incremental-sync.ts — despite three comments in two other files
    // asserting this exact behaviour existed. The 429 became a step failure
    // and Inngest retried on its own backoff instead.
    mock(hospFetchReservationMessages)
      .mockRejectedValueOnce(new RateLimitError(2))
      .mockResolvedValueOnce([])

    const step = makeStep()
    const result = await runMessageSync(step)

    // '2s' is Hospitable's number, not one we invented — the whole point of
    // honouring Retry-After rather than backing off generically.
    expect(step.sleep).toHaveBeenCalledWith(
      expect.stringContaining('rate-limit-sleep'),
      '2s',
    )
    expect(hospFetchReservationMessages).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ action: 'synced' })
  })

  it('hands off to Inngest only after honouring one full Retry-After', async () => {
    // Bounded at one extra attempt, not a loop: if a full provider-specified
    // wait still is not enough the budget is genuinely gone, and Inngest's
    // retries are the correct next layer. Asserting the CALL COUNT is what
    // stops a future change turning this into an unbounded in-step retry loop
    // that would hold an Inngest step open indefinitely.
    mock(hospFetchReservationMessages).mockRejectedValue(new RateLimitError(5))

    const step = makeStep()
    await expect(runMessageSync(step)).rejects.toBeInstanceOf(RateLimitError)

    expect(hospFetchReservationMessages).toHaveBeenCalledTimes(2)
    expect(step.sleep).toHaveBeenCalledTimes(1)
  })

  it('does not sleep at all on a clean call', async () => {
    mock(hospFetchReservationMessages).mockResolvedValue([])

    const step = makeStep()
    await runMessageSync(step)

    expect(step.sleep).not.toHaveBeenCalled()
    expect(hospFetchReservationMessages).toHaveBeenCalledTimes(1)
  })
})

describe('hospIncrementalSync — per-entity concurrency', () => {
  it('allows only ONE in-flight invocation per entity id', () => {
    // GET /reservations/{id}/messages is capped by Hospitable at 2 req/min PER
    // RESERVATION. The limit was 2, which let a single pair of concurrent
    // invocations spend that entire minute's budget before any retry — while
    // the code comment claimed it "prevents duplicate work on the same id",
    // which a limit of 2 does not do. There is no throughput argument for a
    // second slot: the two invocations race to write the same row.
    const concurrency = (hospIncrementalSync as unknown as {
      opts: { concurrency: Array<{ limit: number; key?: string }> }
    }).opts.concurrency

    const perEntity = concurrency.find((c) => c.key === 'event.data.entity_id')
    expect(perEntity).toBeDefined()
    expect(perEntity!.limit).toBe(1)
  })
})
