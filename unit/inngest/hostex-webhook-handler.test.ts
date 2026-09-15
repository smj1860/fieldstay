import { describe, it, expect } from 'vitest'
import { NonRetriableError } from 'inngest'
import { isDeadHostexConnectionError } from '@/lib/inngest/functions/hostex/webhook-handler'
import { HostexApiError } from '@/lib/integrations/providers/hostex-api'

// ============================================================================
// Hostex has no revocation webhook — a dead connection keeps receiving
// deliveries until tomorrow's reconcile catches this same condition and
// revokes it. Before this fix, every one of those deliveries called
// reportError() unconditionally: one Sentry event per webhook, potentially
// many per hour for an active listing, for a condition already known and
// already being handled on its own daily cadence.
// ============================================================================

describe('isDeadHostexConnectionError', () => {
  it('recognizes a Hostex account-action error (401/420) as a dead connection', () => {
    expect(isDeadHostexConnectionError(new HostexApiError(420, '/reservations', 'account suspended'))).toBe(true)
    expect(isDeadHostexConnectionError(new HostexApiError(401, '/reservations', 'unauthorized'))).toBe(true)
  })

  it('unwraps a HostexApiError carried as `cause`', () => {
    // isHostexAccountActionError's own contract: these codes always reach a
    // caller wrapped in a NonRetriableError, never bare.
    const wrapped = new Error('wrapped')
    ;(wrapped as { cause?: unknown }).cause = new HostexApiError(420, '/reservations', 'suspended')
    expect(isDeadHostexConnectionError(wrapped)).toBe(true)
  })

  it('recognizes a bare NonRetriableError (e.g. reconnectRequired) as a dead connection', () => {
    expect(isDeadHostexConnectionError(new NonRetriableError('No Hostex token found'))).toBe(true)
  })

  it('does NOT suppress an ordinary transient error', () => {
    expect(isDeadHostexConnectionError(new Error('ECONNRESET'))).toBe(false)
    expect(isDeadHostexConnectionError(new HostexApiError(500, '/reservations', 'server error'))).toBe(false)
  })
})
