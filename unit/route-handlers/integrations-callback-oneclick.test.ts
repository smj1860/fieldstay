import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { IntegrationProvider } from '@/lib/integrations/types'

vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  holdPendingOAuthCode:                       vi.fn(async () => 'pending_link_1'),
  cleanupExpiredPendingIntegrationArtifacts:  vi.fn(async () => undefined),
}))

import { GET } from '@/app/api/integrations/[provider]/callback/oneclick/route'
import { getProvider } from '@/lib/integrations/registry'
import { holdPendingOAuthCode } from '@/lib/integrations/vault'

const APP_URL = 'https://app.fieldstay.test'

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

function oneclickRequest(providerParam: string, search: string, headers?: HeadersInit) {
  return new NextRequest(
    `http://localhost/api/integrations/${providerParam}/callback/oneclick${search}`,
    headers ? { headers } : undefined,
  )
}

function callGet(providerParam: string, search: string, headers?: HeadersInit) {
  return GET(oneclickRequest(providerParam, search, headers), {
    params: Promise.resolve({ provider: providerParam }),
  })
}

function locationOf(res: Response): string {
  return res.headers.get('location') ?? ''
}

describe('GET /api/integrations/[provider]/callback/oneclick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = APP_URL
  })

  it('redirects to the provider error page when the provider reports an authorization error', async () => {
    const res = await callGet('hospitable', '?error=access_denied&error_description=user+declined')

    // This route's NextResponse.redirect() calls omit an explicit status,
    // so Next.js defaults to a 307 temporary redirect (unlike the standard
    // callback route, which explicitly passes { status: 302 }).
    expect(res.status).toBe(307)
    expect(locationOf(res)).toContain('/connect/error')
    expect(locationOf(res)).toContain('provider=hospitable')
    expect(locationOf(res)).toContain('error=access_denied')
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('rejects a callback missing the code param', async () => {
    const res = await callGet('hospitable', '')
    expect(locationOf(res)).toContain('error=missing_params')
  })

  it('redirects to unknown_provider for an unregistered provider', async () => {
    vi.mocked(getProvider).mockImplementation(() => { throw new Error('not found') })

    const res = await callGet('not-a-real-provider', '?code=abc123')

    expect(locationOf(res)).toContain('error=unknown_provider')
  })

  it('redirects to provider_not_oauth when the provider has no exchangeCodeForToken', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider({ exchangeCodeForToken: undefined }))

    const res = await callGet('hospitable', '?code=abc123')

    expect(locationOf(res)).toContain('error=provider_not_oauth')
    expect(holdPendingOAuthCode).not.toHaveBeenCalled()
  })

  it('redirects to storage_failed when holding the pending code fails', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    vi.mocked(holdPendingOAuthCode).mockRejectedValueOnce(new Error('vault down'))

    const res = await callGet('hospitable', '?code=abc123')

    expect(locationOf(res)).toContain('error=storage_failed')
  })

  it('deferred exchange: NEVER exchanges the code on arrival — the provider must not register a connection before the user signs up', async () => {
    // This is the invariant Hospitable's partner team flagged (2026-07-22):
    // exchanging on the raw GET flipped their UI to "Connected" before any
    // FieldStay account existed. The exchange belongs in /connect/finish,
    // after requireAuth().
    const provider = oauthProvider()
    vi.mocked(getProvider).mockReturnValue(provider)

    await callGet('hospitable', '?code=abc123')

    expect(provider.exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('confused-deputy guard: always holds the code for post-signup claim and never attaches it to any session, regardless of an existing session cookie', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    // Simulate a logged-in FieldStay victim's browser hitting this URL —
    // this route has no auth/session-reading code path at all, so a
    // present session cookie must have zero effect on the outcome.
    const res = await callGet('hospitable', '?code=abc123', {
      cookie: 'sb-access-token=some-active-victim-session',
    })

    expect(holdPendingOAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'hospitable', code: 'abc123' }),
    )
    expect(res.status).toBe(307)
    expect(locationOf(res)).toContain('/signup')
    expect(locationOf(res)).toContain('provider=hospitable')
    expect(locationOf(res)).toContain('next=%2Fconnect%2Ffinish%3Fpending_link%3Dpending_link_1')
  })

  it('holds this route\'s own oneclick redirect URI (not the standard callback URI) for replay on the deferred exchange', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    await callGet('hospitable', '?code=abc123')

    expect(holdPendingOAuthCode).toHaveBeenCalledWith({
      providerId:  'hospitable',
      code:        'abc123',
      redirectUri: `${APP_URL}/api/integrations/hospitable/callback/oneclick`,
    })
  })
})
