import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// refreshHostexToken — terminal vs. transient classification.
//
// This is the whole reason the module exists as more than a one-line cron
// entry. integrationTokenRefreshHandler reads a NonRetriableError as TERMINAL:
// it marks the connection 'revoked' and emails the PM "action required —
// reconnect". Everything else is retried with backoff.
//
// Hostex answers HTTP 200 for every outcome, including a rejected grant, so
// the handler's usual '400'/'401'-substring check cannot classify it — it
// would be decided by whether the error code's digits happen to contain 400.
// refreshHostexToken therefore does the classification itself, and getting it
// wrong is expensive in both directions:
//   - transient misread as terminal -> every Hostex PM told to reconnect a
//     connection that was fine, during what was only a provider blip
//   - terminal misread as transient -> Inngest burns its retries, the
//     connection stays 'active' with a dead token, and since Hostex has no
//     revocation webhook nothing ever corrects it
//
// Also pinned: the cron list and the handler branch agree. Adding 'hostex' to
// OAUTH_PROVIDERS without the handler branch would not no-op — it would hit
// the handler's NonRetriableError fallthrough and revoke every Hostex
// connection on the platform.
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationRefreshToken:  vi.fn(),
  storeIntegrationToken:        vi.fn(),
  storeIntegrationRefreshToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hostex', async (importOriginal) => {
  // Real HostexOAuthError — the classification is an instanceof check, so a
  // stubbed stand-in would make this test pass against a broken implementation.
  const actual = await importOriginal<typeof import('@/lib/integrations/providers/hostex')>()
  return { ...actual, hostexProvider: { ...actual.hostexProvider, refreshAccessToken: vi.fn() } }
})

import { NonRetriableError } from 'inngest'
import { refreshHostexToken } from '@/lib/integrations/providers/hostex-token'
import { hostexProvider, HostexOAuthError } from '@/lib/integrations/providers/hostex'
import { createServiceClient } from '@/lib/supabase/server'
import {
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'

const USER_ID = 'user_hostex_1'
const refreshMock = hostexProvider.refreshAccessToken as unknown as ReturnType<typeof vi.fn>

/** Captures the status writes the module makes against integration_connections. */
function stubSupabase() {
  const updates: Array<Record<string, unknown>> = []
  const chain = {
    update: (payload: Record<string, unknown>) => { updates.push(payload); return chain },
    eq:     () => chain,
    then:   (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
  }
  vi.mocked(createServiceClient).mockReturnValue({ from: () => chain } as never)
  return updates
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readIntegrationRefreshToken).mockResolvedValue('rt_current')
})

describe('refreshHostexToken — happy path', () => {
  it('stores BOTH the new access token and the rotated refresh token', async () => {
    stubSupabase()
    const expiresAt = new Date(Date.now() + 604_800_000).toISOString()
    refreshMock.mockResolvedValue({
      accessToken: 'at_new', refreshToken: 'rt_new', externalUserId: '', expiresAt, metadata: {},
    })

    const token = await refreshHostexToken(USER_ID, '4242')

    expect(token).toBe('at_new')
    // externalUserId threaded through: storeIntegrationToken UPSERTs the
    // connection row, so passing '' would blank the stored identity proxy.
    expect(storeIntegrationToken).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'at_new', externalUserId: '4242', providerId: 'hostex' }),
    )
    expect(storeIntegrationRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'rt_new', expiresAt }),
    )
  })

  it('keeps the existing refresh token rather than clearing it when none is returned', async () => {
    stubSupabase()
    refreshMock.mockResolvedValue({ accessToken: 'at_new', externalUserId: '', metadata: {} })

    await expect(refreshHostexToken(USER_ID, '4242')).resolves.toBe('at_new')
    expect(storeIntegrationRefreshToken).not.toHaveBeenCalled()
  })
})

describe('refreshHostexToken — classification', () => {
  it('treats a rejected grant (error_code !== 0) as TERMINAL and marks the connection error', async () => {
    const updates = stubSupabase()
    refreshMock.mockRejectedValue(new HostexOAuthError(10_002, 'refresh token expired'))

    await expect(refreshHostexToken(USER_ID, '4242')).rejects.toBeInstanceOf(NonRetriableError)
    expect(updates).toEqual([expect.objectContaining({ status: 'error' })])
  })

  it('re-throws a TRANSIENT failure unchanged so Inngest retries instead of revoking', async () => {
    const updates = stubSupabase()
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    refreshMock.mockRejectedValue(timeout)

    await expect(refreshHostexToken(USER_ID, '4242')).rejects.toBe(timeout)
    // Crucially NOT a NonRetriableError, and no status write: a provider blip
    // must not tell the PM their connection is dead.
    await expect(refreshHostexToken(USER_ID, '4242')).rejects.not.toBeInstanceOf(NonRetriableError)
    expect(updates).toEqual([])
  })

  it('is terminal when Vault holds no refresh token — a retry cannot conjure one', async () => {
    stubSupabase()
    vi.mocked(readIntegrationRefreshToken).mockResolvedValue(null)

    await expect(refreshHostexToken(USER_ID, '4242')).rejects.toBeInstanceOf(NonRetriableError)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

describe('cron ↔ handler agreement', () => {
  it('every provider the cron scans has a refresh branch in the handler', async () => {
    const { readFileSync } = await import('fs')
    const { join }         = await import('path')
    const root = join(__dirname, '..', '..')

    const cron    = readFileSync(join(root, 'lib/inngest/functions/cron/integration-token-refresh.ts'), 'utf8')
    const handler = readFileSync(join(root, 'lib/inngest/functions/cron/integration-token-refresh-handler.ts'), 'utf8')

    const listed = /const OAUTH_PROVIDERS = \[([^\]]+)\]/.exec(cron)?.[1] ?? ''
    const ids    = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)

    expect(ids).toContain('hostex')
    for (const id of ids) {
      expect(handler, `${id} is scanned by the cron but has no handler branch — its connections would be revoked`)
        .toContain(`provider_id === '${id}'`)
    }
  })
})
