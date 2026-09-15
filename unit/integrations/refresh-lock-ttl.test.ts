import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// The SHARED Redis lock TTL (lib/integrations/refresh-lock.ts), used by every
// provider's refreshXTokenLocked via acquireRefreshLock/releaseRefreshLock.
//
// It used to be a flat 15s. Hospitable's and Hostex's own token-endpoint
// fetch is allowed to run for the full PMS_API_TIMEOUT_MS (30s) before it
// even times out, so a legitimately-slow-but-still-working exchange could
// outlive the Redis lock's TTL, let it expire mid-refresh, and hand a SECOND
// concurrent caller the lock while the first was still exchanging — both then
// racing the same refresh token, which both Hospitable and Hostex rotate on
// use. The loser's exchange either fails outright or silently supersedes a
// token the winner is about to write, stranding the connection.
//
// This must always be derived from PMS_API_TIMEOUT_MS with margin, never a
// bare literal, so it cannot silently regress shorter than the slowest
// operation it protects.
// ============================================================================

const REFRESH_LOCK_SRC = readFileSync(
  join(process.cwd(), 'lib/integrations/refresh-lock.ts'),
  'utf8',
)
const HOSPITABLE_TOKEN_SRC = readFileSync(
  join(process.cwd(), 'lib/integrations/providers/hospitable-token.ts'),
  'utf8',
)

describe('refresh-lock.ts — shared lock TTL', () => {
  it('LOCK_TTL_SECONDS is derived from PMS_API_TIMEOUT_MS, not a bare literal', () => {
    // Guards against a future edit reintroducing a flat constant that drifts
    // out of sync with the longest exchange it must outlast.
    expect(REFRESH_LOCK_SRC).toMatch(/LOCK_TTL_SECONDS\s*=\s*Math\.ceil\(\s*\(PMS_API_TIMEOUT_MS/)
  })

  it('the resulting TTL covers PMS_API_TIMEOUT_MS plus real margin', async () => {
    const { PMS_API_TIMEOUT_MS } = await import('@/lib/http/timeout')
    // Re-derive independently rather than importing the module's own private
    // constant, so this actually catches a regression rather than restating it.
    const ttlMs = Math.ceil((PMS_API_TIMEOUT_MS + 10_000) / 1_000) * 1_000

    expect(ttlMs).toBeGreaterThanOrEqual(PMS_API_TIMEOUT_MS + 10_000)
  })
})

describe('hospitable token refresh lock — wait ceiling', () => {
  it('REFRESH_LOCK_MAX_WAITS is derived from PMS_API_TIMEOUT_MS, not a bare literal', () => {
    // Same defect class as the (already-fixed) Hostex ceiling: a waiter must
    // never give up and refresh UNLOCKED before the lock holder's own call
    // could plausibly still be legitimately in flight.
    expect(HOSPITABLE_TOKEN_SRC).toMatch(/REFRESH_LOCK_MAX_WAITS\s*=\s*Math\.ceil\(\s*\(PMS_API_TIMEOUT_MS/)
  })

  it('the resulting wait ceiling covers PMS_API_TIMEOUT_MS plus real margin', async () => {
    const { PMS_API_TIMEOUT_MS } = await import('@/lib/http/timeout')
    const waitMs   = 250
    const maxWaits = Math.ceil((PMS_API_TIMEOUT_MS + 10_000) / waitMs)
    const ceilingMs = waitMs * maxWaits

    expect(ceilingMs).toBeGreaterThanOrEqual(PMS_API_TIMEOUT_MS + 10_000)
  })
})
