import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { IntegrationProvider } from '@/lib/integrations/types'

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))

import { GET } from '@/app/api/integrations/[provider]/connect/route'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/integrations/registry'

const APP_URL = 'https://app.fieldstay.test'

function makeAuthClient(user: { id: string } | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user } })) } }
}

function makeAdmin(opts: { insertError?: unknown } = {}) {
  const insertMock = vi.fn((_row: unknown) => Promise.resolve({ error: opts.insertError ?? null }))
  const from = vi.fn(() => ({ insert: insertMock }))
  return { from, insertMock }
}

function oauthProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    id:          'ownerrez',
    displayName: 'OwnerRez',
    authType:    'oauth2',
    getAuthorizationUrl: vi.fn(({ state }: { state: string; redirectUri: string }) =>
      `https://app.ownerrez.com/oauth/authorize?state=${state}`,
    ),
    getApiHeaders:    vi.fn(() => ({})),
    validateWebhook:  vi.fn(),
    handleWebhookEvent: vi.fn(),
    ...overrides,
  }
}

function connectRequest(providerParam: string, search = '') {
  return new NextRequest(`http://localhost/api/integrations/${providerParam}/connect${search}`)
}

function callGet(providerParam: string, search = '') {
  return GET(connectRequest(providerParam, search), { params: Promise.resolve({ provider: providerParam }) })
}

describe('GET /api/integrations/[provider]/connect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = APP_URL
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient(null) as never)
  })

  it('returns 404 for an unregistered provider', async () => {
    vi.mocked(getProvider).mockImplementation(() => { throw new Error('not found') })

    const res = await callGet('not-a-real-provider')

    expect(res.status).toBe(404)
  })

  it('returns 400 for a provider that does not support OAuth2', async () => {
    vi.mocked(getProvider).mockReturnValue(
      oauthProvider({ authType: 'api_key', getAuthorizationUrl: undefined }),
    )

    const res = await callGet('hostaway')

    expect(res.status).toBe(400)
  })

  it('persists a CSRF state row with user_id null for an unauthenticated visitor and redirects to the provider', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    const admin = makeAdmin()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await callGet('ownerrez')

    expect(res.status).toBe(302)
    expect(admin.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null, provider_id: 'ownerrez', return_to: '/settings?tab=integrations' }),
    )
    const location = res.headers.get('location')
    expect(location).toContain('https://app.ownerrez.com/oauth/authorize')
  })

  it('persists the state row scoped to the current session\'s own user id when logged in', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'user_1' }) as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    const admin = makeAdmin()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await callGet('ownerrez')

    expect(admin.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_1' }),
    )
  })

  it('passes a caller-supplied return_to through into the state row', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    const admin = makeAdmin()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await callGet('ownerrez', '?return_to=%2Finventory')

    expect(admin.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ return_to: '/inventory' }),
    )
  })

  it('sets an httpOnly oauth_state cookie matching the persisted state value', async () => {
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    const admin = makeAdmin()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await callGet('ownerrez')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persistedState = (admin.insertMock.mock.calls[0][0] as any).state as string
    const cookie = res.cookies.get('oauth_state_ownerrez')
    expect(cookie?.value).toBe(persistedState)
    expect(cookie?.httpOnly).toBe(true)
  })

  it('redirects to the connect-error page without ever building an authorization URL when state persistence fails', async () => {
    const provider = oauthProvider()
    vi.mocked(getProvider).mockReturnValue(provider)
    const admin = makeAdmin({ insertError: { message: 'db down' } })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await callGet('ownerrez')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/connect/error')
    expect(res.headers.get('location')).toContain('error=state_creation_failed')
    expect(provider.getAuthorizationUrl).not.toHaveBeenCalled()
  })
})
