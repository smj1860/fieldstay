import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { IntegrationProvider } from '@/lib/integrations/types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user_1' } })),
}))
vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  claimPendingOAuthCode:                      vi.fn(),
  cleanupExpiredPendingIntegrationArtifacts:  vi.fn(async () => undefined),
}))
vi.mock('@/lib/integrations/finalize-connection', () => ({
  finalizeIntegrationConnection: vi.fn(async () => ({ orgId: 'org_1' })),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { GET } from '@/app/connect/finish/route'
import { getProvider } from '@/lib/integrations/registry'
import { claimPendingOAuthCode } from '@/lib/integrations/vault'
import { finalizeIntegrationConnection } from '@/lib/integrations/finalize-connection'
import { logAuditEvent } from '@/lib/audit'

const APP_URL = 'https://app.fieldstay.test'

const CLAIMED = {
  providerId:  'hospitable',
  code:        'held_code_1',
  redirectUri: `${APP_URL}/api/integrations/hospitable/callback/oneclick`,
}

function oauthProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    id:          'hospitable',
    displayName: 'Hospitable',
    authType:    'oauth2',
    exchangeCodeForToken: vi.fn(async () => ({
      accessToken:    'access_token_1',
      externalUserId: 'external_user_1',
    })),
    getApiHeaders:      vi.fn(() => ({})),
    validateWebhook:    vi.fn(),
    handleWebhookEvent: vi.fn(),
    ...overrides,
  }
}

function callGet(search: string) {
  return GET(new NextRequest(`http://localhost/connect/finish${search}`))
}

function locationOf(res: Response): string {
  return res.headers.get('location') ?? ''
}

describe('GET /connect/finish (deferred marketplace code exchange)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = APP_URL
  })

  it('redirects to settings when no pending_link param is present', async () => {
    const res = await callGet('')

    expect(locationOf(res)).toContain('/settings?tab=integrations')
    expect(claimPendingOAuthCode).not.toHaveBeenCalled()
  })

  it('redirects to settings with pending_link_expired when the claim finds nothing (expired or already claimed)', async () => {
    vi.mocked(claimPendingOAuthCode).mockResolvedValue(null)

    const res = await callGet('?pending_link=tok1')

    expect(locationOf(res)).toContain('error=pending_link_expired')
    expect(finalizeIntegrationConnection).not.toHaveBeenCalled()
  })

  it('redirects to claim_failed when the claim itself throws', async () => {
    vi.mocked(claimPendingOAuthCode).mockRejectedValue(new Error('vault down'))

    const res = await callGet('?pending_link=tok1')

    expect(locationOf(res)).toContain('/connect/error')
    expect(locationOf(res)).toContain('error=claim_failed')
  })

  it('exchanges the held code AFTER auth, replaying the stored redirect URI, then finalizes and audits as a marketplace install', async () => {
    vi.mocked(claimPendingOAuthCode).mockResolvedValue(CLAIMED)
    const provider = oauthProvider()
    vi.mocked(getProvider).mockReturnValue(provider)

    const res = await callGet('?pending_link=tok1')

    expect(provider.exchangeCodeForToken).toHaveBeenCalledWith({
      code:        'held_code_1',
      redirectUri: CLAIMED.redirectUri,
    })
    expect(finalizeIntegrationConnection).toHaveBeenCalledWith({
      userId:     'user_1',
      providerId: 'hospitable',
      tokenData:  expect.objectContaining({ accessToken: 'access_token_1', externalUserId: 'external_user_1' }),
    })
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId:  'user_1',
        action:   'integration.connected',
        targetId: 'hospitable',
        metadata: expect.objectContaining({ trigger: 'marketplace_install' }),
      }),
    )
    expect(locationOf(res)).toContain('/settings')
    expect(locationOf(res)).toContain('connected=hospitable')
  })

  it('expired-code fallback: a failed exchange restarts the standard connect flow instead of dead-ending', async () => {
    // Provider codes are single-use and short-lived; email-confirmation
    // signup can outlive them. The user is authenticated by now, so the
    // standard flow's re-authorization is a silent auto-approve bounce.
    vi.mocked(claimPendingOAuthCode).mockResolvedValue(CLAIMED)
    vi.mocked(getProvider).mockReturnValue(
      oauthProvider({ exchangeCodeForToken: vi.fn(async () => { throw new Error('invalid_grant') }) }),
    )

    const res = await callGet('?pending_link=tok1')

    expect(locationOf(res)).toContain('/api/integrations/hospitable/connect')
    expect(locationOf(res)).toContain('return_to=')
    expect(finalizeIntegrationConnection).not.toHaveBeenCalled()
  })

  it('redirects to unknown_provider when the claimed provider is no longer registered', async () => {
    vi.mocked(claimPendingOAuthCode).mockResolvedValue(CLAIMED)
    vi.mocked(getProvider).mockImplementation(() => { throw new Error('not found') })

    const res = await callGet('?pending_link=tok1')

    expect(locationOf(res)).toContain('error=unknown_provider')
  })

  it('redirects to storage_failed when finalizing the connection throws', async () => {
    vi.mocked(claimPendingOAuthCode).mockResolvedValue(CLAIMED)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    vi.mocked(finalizeIntegrationConnection).mockRejectedValueOnce(new Error('vault write failed'))

    const res = await callGet('?pending_link=tok1')

    expect(locationOf(res)).toContain('error=storage_failed')
  })
})
