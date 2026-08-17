import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Hostex OAuth adapter — Phase 1.
//
// The point of interest is parseHostexTokenResponse's TWO branches. Hostex's
// token endpoint's response envelope is UNCONFIRMED: every other v3 endpoint
// wraps its payload in { request_id, error_code, error_msg, data } and returns
// HTTP 200 even on failure, but the OAuth token endpoint's schema panel never
// rendered in the doc fetch. The adapter therefore accepts BOTH shapes and
// logs which one fired, so the dead branch can be deleted once a real connect
// confirms it (CLAUDE_HOSTEX_1.md, verification checklist item 5).
//
// These tests pin down what "handles both" has to mean before anyone deletes a
// branch on the strength of one observed connect:
//   - an enveloped success yields the token from `data`
//   - a bare success yields the token from the root
//   - error_code !== 0 THROWS even though the HTTP status is 200 — the whole
//     reason `response.ok` cannot be the success test for this provider
//   - a shape matching neither throws with the keys named, rather than
//     returning a TokenResponse with accessToken: undefined
//
// externalUserId derivation is covered too because it is deliberately
// non-fatal: Hostex has no account-identity endpoint, so a failed or empty
// /properties read must degrade to '' and still complete the connect.
// ============================================================================

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { hostexProvider, HostexOAuthError } from '@/lib/integrations/providers/hostex'
import { IntegrationMisconfiguredError } from '@/lib/integrations/types'

const TOKEN_URL      = 'https://api.hostex.io/v3/oauth/authorizations'
const PROPERTIES_URL = 'https://api.hostex.io/v3/properties?limit=1'

/** Route each fetch by URL so a test never depends on call ORDER. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url   = typeof input === 'string' ? input : input.toString()
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return {
      ok:     (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json:   async () => route.body,
    } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const propertiesOk = {
  body: { request_id: 'r1', error_code: 0, error_msg: '', data: { properties: [{ id: 4242, title: 'Lake House' }], total: 1 } },
}

describe('hostexProvider — credentials', () => {
  beforeEach(() => {
    vi.stubEnv('HOSTEX_CLIENT_ID', 'cid')
    vi.stubEnv('HOSTEX_CLIENT_SECRET', 'csecret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('builds an authorization URL carrying client_id, redirect_uri AND state', () => {
    // Unlike Hospitable, redirect_uri is NOT portal-configured — it must be an
    // explicit query param on every Hostex authorization request.
    const url = new URL(hostexProvider.getAuthorizationUrl!({
      state:       'st4te',
      redirectUri: 'https://app.fieldstay.app/api/integrations/hostex/callback',
    }))

    expect(url.origin + url.pathname).toBe('https://hostex.io/app/authorization')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.fieldstay.app/api/integrations/hostex/callback')
    expect(url.searchParams.get('state')).toBe('st4te')
  })

  it('throws IntegrationMisconfiguredError rather than sending client_id=undefined', () => {
    vi.stubEnv('HOSTEX_CLIENT_ID', '')
    expect(() => hostexProvider.getAuthorizationUrl!({
      state: 's', redirectUri: 'https://app.fieldstay.app/cb',
    })).toThrow(IntegrationMisconfiguredError)
  })

  it('throws IntegrationMisconfiguredError on exchange when the secret is missing', async () => {
    vi.stubEnv('HOSTEX_CLIENT_SECRET', '')
    await expect(hostexProvider.exchangeCodeForToken!({
      code: 'c', redirectUri: 'https://app.fieldstay.app/cb',
    })).rejects.toBeInstanceOf(IntegrationMisconfiguredError)
  })
})

describe('hostexProvider.exchangeCodeForToken — token envelope shapes', () => {
  beforeEach(() => {
    vi.stubEnv('HOSTEX_CLIENT_ID', 'cid')
    vi.stubEnv('HOSTEX_CLIENT_SECRET', 'csecret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads an ENVELOPED token response out of data', async () => {
    mockFetch({
      [TOKEN_URL]: { body: {
        request_id: 'r0', error_code: 0, error_msg: '',
        data: { access_token: 'at_env', refresh_token: 'rt_env', expires_in: 604_800 },
      } },
      [PROPERTIES_URL]: propertiesOk,
    })

    const result = await hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' })

    expect(result.accessToken).toBe('at_env')
    expect(result.refreshToken).toBe('rt_env')
    expect(result.externalUserId).toBe('4242')
    // 7 days, per Hostex's Authorization Workflow doc.
    expect(new Date(result.expiresAt!).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3_600_000)
  })

  it('reads a BARE top-level token response', async () => {
    mockFetch({
      [TOKEN_URL]:      { body: { access_token: 'at_bare', refresh_token: 'rt_bare', expires_in: 604_800 } },
      [PROPERTIES_URL]: propertiesOk,
    })

    const result = await hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' })

    expect(result.accessToken).toBe('at_bare')
    expect(result.refreshToken).toBe('rt_bare')
  })

  it('throws on error_code !== 0 even though the HTTP status is 200', async () => {
    // The Hostex-specific trap: response.ok is true here. Branching on it
    // instead of error_code would store an undefined access token in Vault.
    mockFetch({
      [TOKEN_URL]: { status: 200, body: { request_id: 'r', error_code: 40_001, error_msg: 'invalid code', data: null } },
    })

    await expect(hostexProvider.exchangeCodeForToken!({ code: 'bad', redirectUri: 'https://x/cb' }))
      .rejects.toThrow(/40001|invalid code/)
  })

  it('throws a HostexOAuthError carrying the code, so a dead grant is classifiable', async () => {
    // The refresh handler classifies terminal-vs-transient on this type.
    // A substring check for '400'/'401' — how every other provider is
    // classified — would be decided by the error code's digits here.
    mockFetch({
      [TOKEN_URL]: { body: { request_id: 'r', error_code: 10_002, error_msg: 'refresh token expired', data: null } },
    })

    await expect(hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' }))
      .rejects.toBeInstanceOf(HostexOAuthError)
  })

  it('logs the keys but keeps them OUT of the thrown message when the shape is unknown', async () => {
    // 'hostex' is in the callback's SAFE_DETAIL_PROVIDERS, so this message can
    // reach an unauthenticated visitor via /connect/error?detail=. The
    // diagnostic belongs in the log, not the redirect.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFetch({ [TOKEN_URL]: { body: { token: 'nope', ttl: 1 } } })

    await expect(hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' }))
      .rejects.toThrow('Hostex returned an unrecognized token response')

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('neither known shape'), 'token, ttl')
    errorLog.mockRestore()
  })

  it('throws a status-carrying error on a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('not json') },
    } as unknown as Response)))

    await expect(hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' }))
      .rejects.toThrow(/non-JSON body: HTTP 502/)
  })
})

describe('hostexProvider — externalUserId derivation is best-effort', () => {
  beforeEach(() => {
    vi.stubEnv('HOSTEX_CLIENT_ID', 'cid')
    vi.stubEnv('HOSTEX_CLIENT_SECRET', 'csecret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const tokenOk = { body: { access_token: 'at', refresh_token: 'rt', expires_in: 604_800 } }

  it("falls back to '' — not a thrown connect — when the account has zero properties", async () => {
    mockFetch({
      [TOKEN_URL]:      tokenOk,
      [PROPERTIES_URL]: { body: { request_id: 'r', error_code: 0, error_msg: '', data: { properties: [], total: 0 } } },
    })

    const result = await hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' })
    expect(result.externalUserId).toBe('')
    expect(result.accessToken).toBe('at')
  })

  it("falls back to '' when the properties read fails outright", async () => {
    mockFetch({
      [TOKEN_URL]:      tokenOk,
      [PROPERTIES_URL]: { status: 500, body: {} },
    })

    const result = await hostexProvider.exchangeCodeForToken!({ code: 'c', redirectUri: 'https://x/cb' })
    expect(result.externalUserId).toBe('')
  })
})

describe('hostexProvider.refreshAccessToken', () => {
  beforeEach(() => {
    vi.stubEnv('HOSTEX_CLIENT_ID', 'cid')
    vi.stubEnv('HOSTEX_CLIENT_SECRET', 'csecret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts grant_type=refresh_token to the SAME endpoint and does not re-derive externalUserId', async () => {
    const fetchMock = mockFetch({
      [TOKEN_URL]: { body: {
        request_id: 'r', error_code: 0, error_msg: '',
        data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 604_800 },
      } },
    })

    const result = await hostexProvider.refreshAccessToken!({ refreshToken: 'rt1' })

    expect(result.accessToken).toBe('at2')
    expect(result.refreshToken).toBe('rt2')
    expect(result.externalUserId).toBe('')

    // Exactly one call: no /properties read on the refresh path.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('rt1')
    // Hostex's token endpoint documents NO redirect_uri field.
    expect(body).not.toHaveProperty('redirect_uri')
  })
})

describe('hostexProvider — the generic webhook route stays closed', () => {
  // Hostex deliveries land on /api/webhooks/hostex/[token], which resolves the
  // connection from the URL token and carries the trust-on-first-use secret
  // claim. The generic /api/webhooks/[provider] route must NEVER become a
  // second way in: it has no token, so it would bypass that claim entirely.
  it('rejects any inbound webhook with a reason instead of throwing', async () => {
    const result = await hostexProvider.validateWebhook(new Request('https://app.fieldstay.app/api/webhooks/hostex'))
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/\/api\/webhooks\/hostex\/\[token\]/)
  })

  it('does nothing if handleWebhookEvent is somehow reached', async () => {
    await expect(hostexProvider.handleWebhookEvent!(
      {} as Parameters<NonNullable<typeof hostexProvider.handleWebhookEvent>>[0],
    )).resolves.toBeUndefined()
  })
})

// ============================================================================
// Token revocation. Hostex issues the access and refresh tokens as SEPARATELY
// revocable secrets and /oauth/revoke takes one `token` per call, so revoking
// only the access token leaves a live refresh token able to mint new ones for
// an account the user has just disconnected — and that one has no 7-day
// expiry to eventually close the hole.
// ============================================================================

describe('hostexProvider.revokeAccessToken', () => {
  const OK = { request_id: 'RT1', error_code: 200, error_msg: 'Done.' }

  beforeEach(() => {
    vi.stubEnv('HOSTEX_CLIENT_ID', 'cid')
    vi.stubEnv('HOSTEX_CLIENT_SECRET', 'csecret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  function stubRevoke(...responses: Array<{ error_code: number; error_msg?: string }>) {
    const calls: Array<Record<string, unknown>> = []
    let i = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string))
      const body = responses[Math.min(i++, responses.length - 1)]
      return { ok: true, status: 200, json: async () => body }
    }))
    return calls
  }

  it('revokes BOTH tokens, one call each, with the client credentials', async () => {
    const calls = stubRevoke(OK)

    await hostexProvider.revokeAccessToken!({ token: 'at1', refreshToken: 'rt1' })

    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.token)).toEqual(['at1', 'rt1'])
    for (const call of calls) {
      expect(call.client_id).toBeTruthy()
      expect(call.client_secret).toBeTruthy()
    }
  })

  it('revokes just the access token when no refresh token was stored', async () => {
    const calls = stubRevoke(OK)
    await hostexProvider.revokeAccessToken!({ token: 'at1' })
    expect(calls).toHaveLength(1)
  })

  it('treats an already-invalid token as revoked', async () => {
    // The usual reason a user disconnects is that the connection already
    // broke. "This token is not valid" is the outcome we wanted.
    for (const code of [401, 404]) {
      stubRevoke({ error_code: code, error_msg: 'Invalid token' })
      await expect(hostexProvider.revokeAccessToken!({ token: 'dead' })).resolves.toBeUndefined()
    }
  })

  it('accepts error_code 0 as well as the documented 200', async () => {
    stubRevoke({ error_code: 0 })
    await expect(hostexProvider.revokeAccessToken!({ token: 'at1' })).resolves.toBeUndefined()
  })

  it('still revokes the refresh token when the access token call fails', async () => {
    // The access token is usually the dead one. Aborting on it would leave the
    // longer-lived credential in place — the exact hole this closes.
    const calls = stubRevoke({ error_code: 500, error_msg: 'boom' }, OK)

    await expect(hostexProvider.revokeAccessToken!({ token: 'at1', refreshToken: 'rt1' }))
      .rejects.toThrow(/access: /)

    expect(calls.map((c) => c.token)).toEqual(['at1', 'rt1'])
  })

  it('names which credential failed', async () => {
    stubRevoke({ error_code: 500, error_msg: 'boom' })
    await expect(hostexProvider.revokeAccessToken!({ token: 'at1' }))
      .rejects.toThrow(/error_code 500/)
  })
})
