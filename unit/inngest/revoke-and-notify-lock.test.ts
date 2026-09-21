import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// revokeAndNotify's cross-FUNCTION lock.
//
// Hospitable alone has three cron-fanned callers of revokeAndNotify
// (calendar-sync, teammate-sync, reservation-reconcile) that can all hit the
// SAME dead connection in the same run. Before this lock, each one called
// markProviderConnectionRevoked -> shouldNotifyConnectionError, which reads
// the 4-hour throttle in org_milestones — but nothing had WRITTEN that
// throttle yet (recordConnectionErrorNotified is a separate, LATER step), so
// every concurrent caller read "due" and every one sent the PM an identical
// "reconnect" email for one revocation.
// ============================================================================

vi.mock('@/lib/cache/single-flight', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/integrations/connection-error-notify', () => ({
  recordConnectionErrorNotified: vi.fn(),
}))
vi.mock('@/lib/integrations/connection-revoked', () => ({
  markProviderConnectionRevoked: vi.fn(),
}))

import {
  revokeAndNotify,
  connectionRevokeLockKey,
  type RevokeAndNotifyParams,
} from '@/lib/inngest/functions/shared/revoke-and-notify'
import { acquireLock, releaseLock } from '@/lib/cache/single-flight'
import { reportError } from '@/lib/observability/report-error'
import { recordConnectionErrorNotified } from '@/lib/integrations/connection-error-notify'
import { markProviderConnectionRevoked } from '@/lib/integrations/connection-revoked'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

// Only `run`/`sendEvent` are exercised — the real GetStepTools<...> shape
// carries many more (waitForEvent, sleep, invoke, ...) that this sequence
// never calls, so the fake is cast rather than fully implemented.
function makeStep(): RevokeAndNotifyParams['step'] {
  return {
    run:       vi.fn((_n: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  } as unknown as RevokeAndNotifyParams['step']
}
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const BASE = {
  userId:        'user_1',
  orgId:         'org_1',
  providerId:    'hospitable',
  providerLabel: 'Hospitable',
  err:           new Error('401 Unauthenticated'),
  system:        'inngest:test',
  fnId:          'test-handler',
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(markProviderConnectionRevoked).mockResolvedValue({
    connectionId: 'conn_1',
    humanError:   'Hospitable rejected the connection.',
  })
})

describe('connectionRevokeLockKey', () => {
  it('is the same for two callers naming the same user+provider', () => {
    // This is the only thing that makes the lock meaningful across different
    // Inngest function ids — a mismatched key would silently defeat it.
    expect(connectionRevokeLockKey('user_1', 'hospitable')).toBe(connectionRevokeLockKey('user_1', 'hospitable'))
  })

  it('differs by provider for the same user', () => {
    // One PM can have both a dead Hospitable and a dead Hostex connection at
    // once — those must not serialize against each other.
    expect(connectionRevokeLockKey('user_1', 'hospitable')).not.toBe(connectionRevokeLockKey('user_1', 'hostex'))
  })

  it('differs by user for the same provider', () => {
    expect(connectionRevokeLockKey('user_1', 'hospitable')).not.toBe(connectionRevokeLockKey('user_2', 'hospitable'))
  })
})

describe('revokeAndNotify — cross-function lock', () => {
  it('skips mark/send/record entirely when another caller holds the lock', async () => {
    mock(acquireLock).mockResolvedValue(false)
    const step   = makeStep()
    const logger = makeLogger()

    await revokeAndNotify({ ...BASE, step, logger })

    expect(markProviderConnectionRevoked).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(recordConnectionErrorNotified).not.toHaveBeenCalled()
    expect(releaseLock).not.toHaveBeenCalled() // never held it — nothing to release
  })

  it('still reports the underlying error and warns even when the lock is held elsewhere', async () => {
    // The lock dedupes the PM-facing NOTIFICATION, not the Sentry signal for
    // THIS occurrence of the failure — every caller's own error is still
    // worth seeing.
    mock(acquireLock).mockResolvedValue(false)

    await revokeAndNotify({ ...BASE, step: makeStep(), logger: makeLogger() })

    expect(reportError).toHaveBeenCalledWith(BASE.err, expect.objectContaining({ orgId: BASE.orgId }))
  })

  it('acquires and releases the lock around a successful mark/send/record sequence', async () => {
    mock(acquireLock).mockResolvedValue(true)
    const step = makeStep()

    await revokeAndNotify({ ...BASE, step, logger: makeLogger() })

    expect(acquireLock).toHaveBeenCalledWith(connectionRevokeLockKey('user_1', 'hospitable'), 120)
    expect(markProviderConnectionRevoked).toHaveBeenCalled()
    expect(step.sendEvent).toHaveBeenCalled()
    expect(recordConnectionErrorNotified).toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledWith(connectionRevokeLockKey('user_1', 'hospitable'))
  })

  it('releases the lock even when the mark-revoked step throws', async () => {
    mock(acquireLock).mockResolvedValue(true)
    mock(markProviderConnectionRevoked).mockRejectedValue(new Error('db down'))

    await expect(
      revokeAndNotify({ ...BASE, step: makeStep(), logger: makeLogger() }),
    ).rejects.toThrow('db down')

    expect(releaseLock).toHaveBeenCalledWith(connectionRevokeLockKey('user_1', 'hospitable'))
  })

  it('does not send or record when the throttle says a notification already went out', async () => {
    mock(acquireLock).mockResolvedValue(true)
    mock(markProviderConnectionRevoked).mockResolvedValue(null) // not due yet
    const step = makeStep()

    await revokeAndNotify({ ...BASE, step, logger: makeLogger() })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(recordConnectionErrorNotified).not.toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalledWith(connectionRevokeLockKey('user_1', 'hospitable'))
  })
})
