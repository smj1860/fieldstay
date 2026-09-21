import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// ============================================================================
// lodgifyReservationReconcileHandler — the daily sweep.
//
// This carries MORE weight than its Hostex and Hospitable equivalents, for two
// reasons that are specific to Lodgify:
//
//   1. IT IS CURRENTLY THE ONLY SYNC. Webhook registration is gated off until
//      Lodgify's delivery contract is verified, so between runs of this sweep
//      a connected org receives nothing at all.
//
//   2. IT IS THE ONLY THING THAT CAN NOTICE A DEAD CONNECTION. A rotated API
//      key is the most likely way a Lodgify connection dies, and Lodgify has
//      no revocation webhook — nor any revocation endpoint at all — so nothing
//      else will ever find out. Without the revoke branch the connection sits
//      green in Settings while every sync fails, which is the exact silence
//      three OwnerRez connections sat in for three weeks.
//
// Also pinned: the webhook re-assertion (registration was once attempted
// exactly ONCE, in initial sync, where failure is non-fatal — so a single 5xx
// degraded a connection permanently), and revenueMode 'new-only'.
// ============================================================================

vi.mock('@/lib/integrations/vault', () => ({ readIntegrationToken: vi.fn() }))
vi.mock('@/lib/integrations/providers/lodgify-webhook', () => ({
  ensureLodgifyWebhookRegistration: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/lodgify/reservation-sync', () => ({
  syncLodgifyReservations: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/shared/reconcile-shell', () => ({
  runProviderReconcile: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/shared/revoke-and-notify', () => ({
  revokeAndNotify: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { lodgifyReservationReconcileHandler } from '@/lib/inngest/functions/lodgify/reservation-reconcile-handler'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { ensureLodgifyWebhookRegistration } from '@/lib/integrations/providers/lodgify-webhook'
import { syncLodgifyReservations } from '@/lib/inngest/functions/lodgify/reservation-sync'
import { runProviderReconcile } from '@/lib/inngest/functions/shared/reconcile-shell'
import { revokeAndNotify } from '@/lib/inngest/functions/shared/revoke-and-notify'
import { ProviderAuthError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function run() {
  return invokeHandler(lodgifyReservationReconcileHandler, {
    event:  { data: { user_id: 'user_1', org_id: 'org_1', external_user_id: '' } },
    step:   { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn(), sleep: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
}

/** Runs the shell's `sync` callback for real, so this file covers it. */
function passthroughShell() {
  mock(runProviderReconcile).mockImplementation(async (p: {
    readToken: () => Promise<string>
    sync: (getToken: () => Promise<string>, map: Record<string, string>) => Promise<unknown>
  }) => {
    const result = await p.sync(p.readToken, { '42': 'uuid-42' })
    return { properties: 1, reservations: (result as { reservationCount: number }).reservationCount, turnovers: 0 }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('api-key')
  mock(syncLodgifyReservations).mockResolvedValue({ reservationCount: 4, newTurnoverIds: [] })
  mock(ensureLodgifyWebhookRegistration).mockResolvedValue({ attempted: false, created: 0, reason: 'disabled' })
  passthroughShell()
})

describe('the sweep itself', () => {
  it("uses revenueMode 'new-only'", async () => {
    // 'all' would fire one booking/confirmed per confirmed booking per org
    // every day — thousands of guaranteed no-ops.
    await run()
    expect(mock(syncLodgifyReservations).mock.calls[0]![0].revenueMode).toBe('new-only')
  })

  it('sweeps one month back and six months forward', async () => {
    // The lookahead MATCHES the initial sync's. A sweep covering less would
    // leave a permanent blind band beyond its own horizon — and with webhooks
    // gated off, nothing else would ever reach it.
    expect(mock(syncLodgifyReservations).mock.calls).toHaveLength(0)
    await run()

    expect(mock(syncLodgifyReservations).mock.calls[0]![0].fetchMode)
      .toEqual({ kind: 'window', historyMonths: 1, lookaheadMonths: 6 })
  })

  it('fails NON-retriably when the API key is gone', async () => {
    mock(readIntegrationToken).mockResolvedValue(null)
    mock(runProviderReconcile).mockImplementation(async (p: { readToken: () => Promise<string> }) => p.readToken())

    await expect(run()).rejects.toBeInstanceOf(NonRetriableError)
  })
})

describe('webhook re-assertion', () => {
  it('re-asserts the registration on every pass', async () => {
    // It was once attempted exactly ONCE, in initial sync, where a failure is
    // deliberately non-fatal — so a connection that hit a 5xx during its one
    // attempt degraded permanently to daily-only with a green connection to
    // show for it.
    await run()
    expect(ensureLodgifyWebhookRegistration).toHaveBeenCalledWith('user_1', 'api-key')
  })

  it('does not fail the sweep when re-registration throws', async () => {
    // This pass has already imported bookings; failing it over a registration
    // would throw that away and re-do it tomorrow.
    mock(ensureLodgifyWebhookRegistration).mockRejectedValue(new Error('Lodgify 503'))

    await expect(run()).resolves.toMatchObject({ reservations: 4 })
  })
})

describe('revoking a dead connection', () => {
  it('revokes and notifies when Lodgify refuses the credential', async () => {
    // The ONLY place this can be noticed — Lodgify has no revocation webhook.
    const authFailure = new NonRetriableError('denied')
    ;(authFailure as { cause?: unknown }).cause = new ProviderAuthError('Lodgify', 401, '/properties')
    mock(runProviderReconcile).mockRejectedValue(authFailure)

    await expect(run()).resolves.toEqual({ revoked: true })
    expect(revokeAndNotify).toHaveBeenCalledTimes(1)
    expect(mock(revokeAndNotify).mock.calls[0]![0]).toMatchObject({
      userId: 'user_1', orgId: 'org_1', providerId: 'lodgify', providerLabel: 'Lodgify',
    })
  })

  it('does NOT revoke on an ordinary failure', async () => {
    // A transient 5xx or a timeout must never revoke a working connection —
    // which is why this is caught OUTSIDE the runner's steps, after Inngest
    // has exhausted its retries.
    mock(runProviderReconcile).mockRejectedValue(new Error('ECONNRESET'))

    await expect(run()).rejects.toThrow('ECONNRESET')
    expect(revokeAndNotify).not.toHaveBeenCalled()
  })

  it('does not revoke on a plain rate-limit failure either', async () => {
    mock(runProviderReconcile).mockRejectedValue(new Error('Rate limited — retry after 30s'))

    await expect(run()).rejects.toBeTruthy()
    expect(revokeAndNotify).not.toHaveBeenCalled()
  })
})
