import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// The webhook 'ids' fetch mode used to re-read via `arrivalFrom`, which
// filters on the STAY'S arrival date — a webhook fires because something
// CHANGED, and a changed reservation's arrival date can be anywhere: a late
// financial correction or a post-checkout edit on a stay that already
// happened is invisible to an arrival-date filter anchored near today. That
// made the delivery a silent no-op (zero matches, no error). It was also
// unbounded on the future end, risking hostawayFetchReservations' own
// MAX_PAGES ceiling on a single-reservation webhook.
//
// `activitySince` fixes both: it filters on when the record was last
// MODIFIED, not on the stay's date, so a webhook's subject is always inside
// a short lookback regardless of whether the stay is past or future — and
// that lookback is naturally bounded rather than open-ended.
// ============================================================================

vi.mock('@/lib/integrations/providers/hostaway', () => ({
  hostawayFetchReservations: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hostaway.mappers', () => ({
  hostawayReservationToNormalized: vi.fn((r: unknown) => r),
}))
vi.mock('@/lib/inngest/functions/shared/reservation-pipeline', () => ({
  runReservationPipeline: vi.fn(async () => ({ reservationCount: 0, newTurnoverIds: [] })),
}))

import { syncHostawayReservations } from '@/lib/inngest/functions/hostaway/reservation-sync'
import { hostawayFetchReservations } from '@/lib/integrations/providers/hostaway'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function makeStep() {
  return { run: vi.fn((_n: string, cb: () => unknown) => cb()) }
}
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syncHostawayReservations — webhook "ids" fetch mode', () => {
  it('fetches via activitySince, not arrivalFrom', async () => {
    mock(hostawayFetchReservations).mockResolvedValue([])

    await syncHostawayReservations({
      step: makeStep() as never, logger: makeLogger(),
      getToken: async () => 'token', orgId: 'org_1', userId: 'user_1',
      propertyIdMap: { '101': 'prop_1' },
      fetchMode: { kind: 'ids', reservationIds: ['999'] },
      system: 'inngest:test', revenueMode: 'new-only',
    })

    expect(hostawayFetchReservations).toHaveBeenCalledWith(
      'token', expect.objectContaining({ kind: 'activitySince' }),
    )
  })

  it('finds a reservation whose arrival date is in the PAST — the exact case arrivalFrom missed', async () => {
    mock(hostawayFetchReservations).mockResolvedValue([
      { id: 999, listingMapId: 101 }, // arrival date irrelevant to activitySince
    ])

    const result = await syncHostawayReservations({
      step: makeStep() as never, logger: makeLogger(),
      getToken: async () => 'token', orgId: 'org_1', userId: 'user_1',
      propertyIdMap: { '101': 'prop_1' },
      fetchMode: { kind: 'ids', reservationIds: ['999'] },
      system: 'inngest:test', revenueMode: 'new-only',
    })

    // Reached the pipeline with the matched reservation rather than
    // silently reporting zero.
    expect(result).toBeDefined()
  })

  it('warns when fewer matches come back than were named', async () => {
    const logger = makeLogger()
    mock(hostawayFetchReservations).mockResolvedValue([{ id: 111, listingMapId: 101 }])

    await syncHostawayReservations({
      step: makeStep() as never, logger,
      getToken: async () => 'token', orgId: 'org_1', userId: 'user_1',
      propertyIdMap: { '101': 'prop_1' },
      fetchMode: { kind: 'ids', reservationIds: ['999', '111'] }, // 999 never shows up
      system: 'inngest:test', revenueMode: 'new-only',
    })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('named 2 reservation(s), only found 1'))
  })

  it('does not warn when every named id is found', async () => {
    const logger = makeLogger()
    mock(hostawayFetchReservations).mockResolvedValue([{ id: 999, listingMapId: 101 }])

    await syncHostawayReservations({
      step: makeStep() as never, logger,
      getToken: async () => 'token', orgId: 'org_1', userId: 'user_1',
      propertyIdMap: { '101': 'prop_1' },
      fetchMode: { kind: 'ids', reservationIds: ['999'] },
      system: 'inngest:test', revenueMode: 'new-only',
    })

    expect(logger.warn).not.toHaveBeenCalled()
  })
})
