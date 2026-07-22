import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { IntegrationProvider } from '@/lib/integrations/types'

vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  holdPendingIntegrationToken: vi.fn(async () => 'pending_link_1'),
}))

import { GET } from '@/app/api/integrations/[provider]/callback/oneclick/route'
import { getProvider } from '@/lib/integrations/registry'
import { holdPendingIntegrationToken } from '@/lib/integrations/vault'

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
  })

  it('redirects to token_exchange_failed when the provider adapter throws during exchange', async () => {
    vi.mocked(getProvider).mockReturnValue(
      oauthProvider({ exchangeCodeForToken: vi.fn(async () => { throw new Error('bad code') }) }),
    )

    const res = await callGet('hospitable', '?code=bad-code')

    expect(locationOf(res)).toContain('error=token_exchange_failed')
    expect(holdPendingIntegrationToken).not.toHaveBeenCalled()
  })

  it('redirects to storage_failed when holding the pending token fails', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    vi.mocked(holdPendingIntegrationToken).mockRejectedValueOnce(new Error('vault down'))

    const res = await callGet('hospitable', '?code=abc123')

    expect(locationOf(res)).toContain('error=storage_failed')
  })

  it('confused-deputy guard: always holds the token for post-signup claim and never attaches it to any session, regardless of an existing session cookie', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    // Simulate a logged-in FieldStay victim's browser hitting this URL —
    // this route has no auth/session-reading code path at all, so a
    // present session cookie must have zero effect on the outcome.
    const res = await callGet('hospitable', '?code=abc123', {
      cookie: 'sb-access-token=some-active-victim-session',
    })

    expect(holdPendingIntegrationToken).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'hospitable', externalUserId: 'external_user_1', accessToken: 'access_token_1' }),
    )
    expect(res.status).toBe(307)
    expect(locationOf(res)).toContain('/signup')
    expect(locationOf(res)).toContain('provider=hospitable')
    expect(locationOf(res)).toContain('next=%2Fconnect%2Ffinish%3Fpending_link%3Dpending_link_1')
  })

  it('passes this route\'s own oneclick redirect URI (not the standard callback URI) to the token exchange', async () => {
    const provider = oauthProvider()
    vi.mocked(getProvider).mockReturnValue(provider)

    await callGet('hospitable', '?code=abc123')

    expect(provider.exchangeCodeForToken).toHaveBeenCalledWith({
      code:        'abc123',
      redirectUri: `${APP_URL}/api/integrations/hospitable/callback/oneclick`,
    })
  })
})
