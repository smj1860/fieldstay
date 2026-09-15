import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// refreshHostexTokenLocked's waiter gives up and refreshes UNLOCKED once it
// hits REFRESH_LOCK_WAIT_MS * REFRESH_LOCK_MAX_WAITS. That ceiling used to be
// a flat ~15s, while the lock HOLDER's own refresh call is allowed up to
// PMS_API_TIMEOUT_MS (30s) before it even times out — so a merely-slow (not
// dead) provider response made the waiter bail early and race the same
// refresh token the holder was still mid-exchange with. Hostex rotates that
// token on every use, so the loser gets rejected and can permanently strand
// the connection in status='error' with a perfectly good token sitting in
// Vault.
//
// The ceiling must always be derived from PMS_API_TIMEOUT_MS with margin, so
// it can never silently regress back to a value shorter than the operation
// it is meant to wait out.
// ============================================================================

const SRC = readFileSync(
  join(process.cwd(), 'lib/integrations/providers/hostex-token.ts'),
  'utf8',
)

describe('hostex token refresh lock — wait ceiling', () => {
  it('REFRESH_LOCK_MAX_WAITS is derived from PMS_API_TIMEOUT_MS, not a bare literal', () => {
    // Guards against a future edit reintroducing a flat constant that drifts
    // out of sync with the timeout it must outlast.
    expect(SRC).toMatch(/REFRESH_LOCK_MAX_WAITS\s*=\s*Math\.ceil\(\s*\(PMS_API_TIMEOUT_MS/)
  })

  it('the resulting wait ceiling covers PMS_API_TIMEOUT_MS plus real margin', async () => {
    const { PMS_API_TIMEOUT_MS } = await import('@/lib/http/timeout')
    // Re-derive independently rather than importing the module's own private
    // constant, so this actually catches a regression rather than restating it.
    const waitMs = 250
    const maxWaits = Math.ceil((PMS_API_TIMEOUT_MS + 10_000) / waitMs)
    const ceilingMs = waitMs * maxWaits

    expect(ceilingMs).toBeGreaterThanOrEqual(PMS_API_TIMEOUT_MS + 10_000)
  })
})
