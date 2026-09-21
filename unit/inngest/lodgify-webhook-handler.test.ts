import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// ============================================================================
// lodgifyWebhookHandler — the half of the webhook path that does the work.
//
// The route (covered in unit/webhooks/lodgify-webhook-route.test.ts) reads AT
// MOST a booking id out of an unsigned delivery. This function is what turns
// that into real state, and the orchestration is where it can be wrong while
// compiling perfectly:
//
//   - booking_id present  → re-read THAT booking from the API with our own key
//   - booking_id null     → sweep a short recent window instead of dropping
//
// The null case is the point. Lodgify's payload shape is unverified (see
// lodgify.types.ts), so "the id field is spelled differently than we guessed"
// is a live possibility rather than a theoretical one — and the fallback is
// what makes a wrong guess cost extra work instead of a lost booking.
//
// Also pinned: revenueMode 'all' (a booking_change must be able to post
// revenue that failed the first time), and the Sentry suppression for a
// connection already known to be dead.
// ============================================================================

vi.mock('@/lib/integrations/vault', () => ({ readIntegrationToken: vi.fn() }))
vi.mock('@/lib/inngest/functions/shared/reservation-pipeline', () => ({
  fetchProviderPropertyIdMap: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/lodgify/reservation-sync', () => ({
  syncLodgifyReservations: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import {
  isDeadLodgifyConnectionError,
  lodgifyWebhookHandler,
} from '@/lib/inngest/functions/lodgify/webhook-handler'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { fetchProviderPropertyIdMap } from '@/lib/inngest/functions/shared/reservation-pipeline'
import { syncLodgifyReservations } from '@/lib/inngest/functions/lodgify/reservation-sync'
import { reportError } from '@/lib/observability/report-error'
import { ProviderAuthError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function run(data: { booking_id: string | null; event?: string }) {
  return invokeHandler(lodgifyWebhookHandler, {
    event: { data: { user_id: 'user_1', org_id: 'org_1', event: data.event ?? 'booking_change', booking_id: data.booking_id } },
    step:  { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn(), sleep: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
}

/** The fetchMode syncLodgifyReservations was actually asked for. */
function fetchMode(): Record<string, unknown> {
  return mock(syncLodgifyReservations).mock.calls.at(-1)![0].fetchMode
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('api-key')
  mock(fetchProviderPropertyIdMap).mockResolvedValue({ '42': 'uuid-42' })
  mock(syncLodgifyReservations).mockResolvedValue({ reservationCount: 1, newTurnoverIds: ['t1'] })
})

describe('fetch mode', () => {
  it('re-reads the named booking when the delivery carried an id', async () => {
    await run({ booking_id: '9001' })
    expect(fetchMode()).toEqual({ kind: 'ids', bookingIds: ['9001'] })
  })

  it('sweeps a short recent window when the delivery named no booking', async () => {
    // A body we could not parse, or one whose id field is spelled differently
    // than lodgify.types.ts guesses. Dropping it would lose the change.
    await run({ booking_id: null })

    expect(fetchMode()).toEqual({ kind: 'window', historyMonths: 1, lookaheadMonths: 1 })
  })

  it('keeps the fallback window NARROW', async () => {
    // This runs per delivery. A wide window would turn every unrecognised
    // payload into a full backfill against a rate limit whose real ceiling is
    // unverified — and the daily reconcile's far wider sweep already covers
    // anything outside this band.
    await run({ booking_id: null })

    const mode = fetchMode() as { historyMonths: number; lookaheadMonths: number }
    expect(mode.historyMonths).toBeLessThanOrEqual(1)
    expect(mode.lookaheadMonths).toBeLessThanOrEqual(1)
  })

  it("posts revenue with revenueMode 'all', never 'new-only'", async () => {
    // A booking_change for a stay we already hold must still be able to post
    // revenue that failed the first time; the post is idempotent.
    await run({ booking_id: '9001' })
    expect(mock(syncLodgifyReservations).mock.calls.at(-1)![0].revenueMode).toBe('all')
  })
})

describe('skips', () => {
  it('skips when the org has no Lodgify properties yet', async () => {
    mock(fetchProviderPropertyIdMap).mockResolvedValue({})

    await expect(run({ booking_id: '9001' })).resolves.toEqual({ skipped: true, reason: 'no_properties' })
    expect(syncLodgifyReservations).not.toHaveBeenCalled()
  })

  it('fails NON-retriably when the API key is gone', async () => {
    // A missing credential cannot be fixed by retrying, only by reconnecting.
    mock(readIntegrationToken).mockResolvedValue(null)
    mock(syncLodgifyReservations).mockImplementation(async (p: { getToken: () => Promise<string> }) => p.getToken())

    await expect(run({ booking_id: '9001' })).rejects.toBeInstanceOf(NonRetriableError)
  })
})

describe('error reporting', () => {
  it('reports an ordinary failure', async () => {
    mock(syncLodgifyReservations).mockRejectedValue(new Error('ECONNRESET'))

    await expect(run({ booking_id: '9001' })).rejects.toThrow('ECONNRESET')
    expect(reportError).toHaveBeenCalled()
  })

  it('SUPPRESSES the report for a connection already known to be dead', async () => {
    // Lodgify has no revocation webhook, so it keeps pushing to a registered
    // URL until the daily reconcile revokes the connection. Reporting each of
    // those is one Sentry event per delivery for a condition already being
    // handled on its own cadence.
    mock(syncLodgifyReservations).mockRejectedValue(
      new NonRetriableError('Lodgify denied /properties (401)'),
    )

    await expect(run({ booking_id: '9001' })).rejects.toBeTruthy()
    expect(reportError).not.toHaveBeenCalled()
  })

  it('still rethrows the suppressed error — suppressing the REPORT is not swallowing', async () => {
    mock(syncLodgifyReservations).mockRejectedValue(new NonRetriableError('dead'))
    await expect(run({ booking_id: '9001' })).rejects.toThrow('dead')
  })
})

describe('isDeadLodgifyConnectionError', () => {
  it('recognizes an auth failure, including one carried as `cause`', () => {
    const auth = new ProviderAuthError('Lodgify', 401, '/properties')
    expect(isDeadLodgifyConnectionError(auth)).toBe(true)

    const wrapped = new Error('wrapped')
    ;(wrapped as { cause?: unknown }).cause = auth
    expect(isDeadLodgifyConnectionError(wrapped)).toBe(true)
  })

  it('recognizes a bare NonRetriableError (e.g. reconnectRequired)', () => {
    expect(isDeadLodgifyConnectionError(new NonRetriableError('No Lodgify API key found'))).toBe(true)
  })

  it('does NOT suppress an ordinary transient error', () => {
    expect(isDeadLodgifyConnectionError(new Error('ECONNRESET'))).toBe(false)
    expect(isDeadLodgifyConnectionError(new Error('HTTP 503'))).toBe(false)
  })
})
