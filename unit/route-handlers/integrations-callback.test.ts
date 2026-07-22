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
vi.mock('@/lib/integrations/vault', () => ({
  storeIntegrationToken:        vi.fn(async () => 'secret_1'),
  storeIntegrationRefreshToken: vi.fn(async () => undefined),
  holdPendingIntegrationToken:  vi.fn(async () => 'pending_link_1'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { GET } from '@/app/api/integrations/[provider]/callback/route'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/integrations/registry'
import { storeIntegrationToken, storeIntegrationRefreshToken, holdPendingIntegrationToken } from '@/lib/integrations/vault'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

const APP_URL = 'https://app.fieldstay.test'
const FUTURE  = new Date(Date.now() + 60_000).toISOString()

function makeAuthClient(user: { id: string } | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user } })) } }
}

type QueuedByTable = Record<string, Array<{ data?: unknown; error?: unknown }>>

function makeAdmin(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.gt     = (...a: unknown[]) => record('gt', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.or     = (...a: unknown[]) => record('or', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function oauthProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    id:          'ownerrez',
    displayName: 'OwnerRez',
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

function callbackRequest(providerParam: string, search: string) {
  return new NextRequest(`http://localhost/api/integrations/${providerParam}/callback${search}`)
}

function callGet(providerParam: string, search: string) {
  return GET(callbackRequest(providerParam, search), { params: Promise.resolve({ provider: providerParam }) })
}

function locationOf(res: Response): string {
  return res.headers.get('location') ?? ''
}

describe('GET /api/integrations/[provider]/callback (OAuth CSRF state validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = APP_URL
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient(null) as never)
  })

  it('redirects to the provider error page when the provider itself reports an authorization error, without ever validating state', async () => {
    const res = await callGet('ownerrez', '?error=access_denied&error_description=user+declined')

    expect(res.status).toBe(302)
    expect(locationOf(res)).toContain('/connect/error')
    expect(locationOf(res)).toContain('error=access_denied')
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a callback missing the code param', async () => {
    const res = await callGet('ownerrez', '?state=some-state')
    expect(locationOf(res)).toContain('error=missing_params')
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a callback missing the state param', async () => {
    const res = await callGet('ownerrez', '?code=abc123')
    expect(locationOf(res)).toContain('error=missing_params')
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('CSRF: rejects a state value with no matching oauth_states row, before ever loading the provider or exchanging the code', async () => {
    const admin = makeAdmin({ oauth_states: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await callGet('ownerrez', '?code=abc123&state=forged-or-unknown-state')

    expect(locationOf(res)).toContain('error=invalid_state')
    expect(getProvider).not.toHaveBeenCalled()
    expect(admin.calls.some((c) => c.table === 'oauth_states' && c.method === 'delete')).toBe(false)

    const eqCalls = admin.calls.filter((c) => c.table === 'oauth_states' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'state' && c.args[1] === 'forged-or-unknown-state')).toBe(true)
    expect(eqCalls.some((c) => c.args[0] === 'provider_id' && c.args[1] === 'ownerrez')).toBe(true)
    expect(admin.calls.some((c) => c.table === 'oauth_states' && c.method === 'gt' && c.args[0] === 'expires_at')).toBe(true)
  })

  it('CSRF: an expired state row (past expires_at) is excluded by the query and treated as invalid', async () => {
    // The `.gt('expires_at', now)` filter means an expired row simply never
    // matches — modeled here the same way as "no row found".
    const admin = makeAdmin({ oauth_states: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await callGet('ownerrez', '?code=abc123&state=expired-state')

    expect(locationOf(res)).toContain('error=invalid_state')
  })

  it('CSRF: a state row scoped to a different provider_id than the callback URL does not validate (query filters on both)', async () => {
    const admin = makeAdmin({ oauth_states: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    // A state minted for 'kroger' presented on the 'ownerrez' callback.
    await callGet('ownerrez', '?code=abc123&state=state-for-kroger')

    const eqCalls = admin.calls.filter((c) => c.table === 'oauth_states' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'provider_id' && c.args[1] === 'ownerrez')).toBe(true)
  })

  it('consumes (deletes) a valid state exactly once, before doing anything else, preventing replay', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 'good-state', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockImplementation(() => { throw new Error('unknown') })

    await callGet('ownerrez', '?code=abc123&state=good-state')

    const deleteCall = admin.calls.find((c) => c.table === 'oauth_states' && c.method === 'delete')
    expect(deleteCall).toBeDefined()
    const eqAfterDelete = admin.calls.filter((c) => c.table === 'oauth_states' && c.method === 'eq')
    expect(eqAfterDelete.some((c) => c.args[0] === 'state' && c.args[1] === 'good-state')).toBe(true)
  })

  it('redirects to unknown_provider when the state is valid but the provider is no longer registered', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockImplementation(() => { throw new Error('unknown') })

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    expect(locationOf(res)).toContain('error=unknown_provider')
  })

  it('redirects to provider_not_oauth when the provider has no exchangeCodeForToken', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'kroger', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider({ exchangeCodeForToken: undefined }))

    const res = await callGet('kroger', '?code=abc123&state=s1')

    expect(locationOf(res)).toContain('error=provider_not_oauth')
  })

  it('redirects to token_exchange_failed when the provider adapter throws during exchange', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(
      oauthProvider({ exchangeCodeForToken: vi.fn(async () => { throw new Error('bad code') }) }),
    )

    const res = await callGet('ownerrez', '?code=bad-code&state=s1')

    expect(locationOf(res)).toContain('error=token_exchange_failed')
    expect(storeIntegrationToken).not.toHaveBeenCalled()
  })

  it('holds the token for post-signup claim (never attaches it) when neither an active session nor the state row carries a user id', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    expect(holdPendingIntegrationToken).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'ownerrez', externalUserId: 'external_user_1' }),
    )
    expect(storeIntegrationToken).not.toHaveBeenCalled()
    expect(locationOf(res)).toContain('/signup')
    expect(locationOf(res)).toContain('next=%2Fconnect%2Ffinish%3Fpending_link%3Dpending_link_1')
  })

  it('redirects to storage_failed when holding a pending token fails', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    vi.mocked(holdPendingIntegrationToken).mockRejectedValueOnce(new Error('vault down'))

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    expect(locationOf(res)).toContain('error=storage_failed')
  })

  it('IDOR/session-priority: an active session always wins over a user_id recorded on the state row', async () => {
    // The state row was minted for a different user_id (e.g. the flow
    // started signed out and the browser later signed into a different
    // account) — the currently authenticated session must be the one the
    // connection attaches to, never the state row's stashed value.
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: 'stale_state_user', return_to: null }, error: null }],
      organization_members: [{ data: null, error: null }],
      integration_connections: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    await callGet('ownerrez', '?code=abc123&state=s1')

    expect(storeIntegrationToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'session_user' }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'session_user' }),
    )
  })

  it('falls back to the state row\'s user_id only when there is no active session', async () => {
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: 'state_user', return_to: null }, error: null }],
      organization_members: [{ data: null, error: null }],
      integration_connections: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    await callGet('ownerrez', '?code=abc123&state=s1')

    expect(storeIntegrationToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'state_user' }),
    )
  })

  it('scopes the membership lookup used to link the connection to an org by the resolved user id, requiring an accepted invite', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
      organization_members: [{ data: { org_id: 'org_1' }, error: null }],
      integration_connections: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    await callGet('ownerrez', '?code=abc123&state=s1')

    const eqCalls = admin.calls.filter((c) => c.table === 'organization_members' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'user_id' && c.args[1] === 'session_user')).toBe(true)
    const notCalls = admin.calls.filter((c) => c.table === 'organization_members' && c.method === 'not')
    expect(notCalls.some((c) => c.args[0] === 'invite_accepted_at')).toBe(true)

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'integration/ownerrez.connected',
      data: { user_id: 'session_user', org_id: 'org_1', external_user_id: 'external_user_1' },
    })
  })

  it('never fires the provider-connected event when the user has no org yet', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
      organization_members: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    await callGet('ownerrez', '?code=abc123&state=s1')

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('never fires a connected event for a provider absent from the dispatch table (e.g. hostaway), even with an org', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'hostaway', user_id: null, return_to: null }, error: null }],
      organization_members: [{ data: { org_id: 'org_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider({ id: 'hostaway', displayName: 'Hostaway' }))

    await callGet('hostaway', '?code=abc123&state=s1')

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('stores a refresh token when the provider returns one', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'kroger', user_id: null, return_to: null }, error: null }],
      organization_members: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(
      oauthProvider({
        id: 'kroger',
        exchangeCodeForToken: vi.fn(async () => ({
          accessToken: 'a1', externalUserId: 'ext1', refreshToken: 'r1', expiresAt: FUTURE,
        })),
      }),
    )

    await callGet('kroger', '?code=abc123&state=s1')

    expect(storeIntegrationRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'session_user', providerId: 'kroger', refreshToken: 'r1' }),
    )
  })

  it('redirects to storage_failed when writing the token to Vault throws', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())
    vi.mocked(storeIntegrationToken).mockRejectedValueOnce(new Error('vault write failed'))

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    expect(locationOf(res)).toContain('error=storage_failed')
  })

  it('open-redirect guard: falls back to the default path when the stored return_to is an absolute/external URL', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: 'https://evil.example/steal' }, error: null }],
      organization_members: [{ data: null, error: null }],
      integration_connections: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    const location = locationOf(res)
    expect(location.startsWith(`${APP_URL}/settings?tab=integrations`)).toBe(true)
    expect(location).not.toContain('evil.example')
  })

  it('happy path: stores the token, links the org, revalidates, audits, and redirects with a connected flag', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: 'session_user' }) as never)
    const admin = makeAdmin({
      oauth_states: [{ data: { state: 's1', provider_id: 'ownerrez', user_id: null, return_to: '/inventory' }, error: null }],
      organization_members: [{ data: { org_id: 'org_1' }, error: null }],
      integration_connections: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(getProvider).mockReturnValue(oauthProvider())

    const res = await callGet('ownerrez', '?code=abc123&state=s1')

    expect(res.status).toBe(302)
    const location = locationOf(res)
    expect(location.startsWith(`${APP_URL}/inventory`)).toBe(true)
    expect(location).toContain('connected=ownerrez')

    expect(storeIntegrationToken).toHaveBeenCalledWith({
      userId:         'session_user',
      providerId:     'ownerrez',
      accessToken:    'access_token_1',
      externalUserId: 'external_user_1',
      scope:          undefined,
      metadata:       undefined,
    })

    const updateCall = admin.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updateCall).toBeDefined()
    const connectionsEq = admin.calls.filter((c) => c.table === 'integration_connections' && c.method === 'eq')
    expect(connectionsEq.some((c) => c.args[0] === 'user_id' && c.args[1] === 'session_user')).toBe(true)
    expect(connectionsEq.some((c) => c.args[0] === 'provider_id' && c.args[1] === 'ownerrez')).toBe(true)

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'session_user', action: 'integration.connected', targetId: 'ownerrez' }),
    )
  })

  it('clears the one-time oauth_state cookie on every exit path, including error redirects', async () => {
    const res = await callGet('ownerrez', '?error=access_denied')

    const cookie = res.cookies.get('oauth_state_ownerrez')
    // next/server represents a cleared cookie with an empty value and maxAge 0
    expect(cookie?.value).toBe('')
  })
})
