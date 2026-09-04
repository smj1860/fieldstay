import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildRequestFlowUrl,
  isThumbtackConfigured,
  THUMBTACK_CATEGORY_MAP,
  searchThumbtackPros,
  invalidateThumbtackToken,
  type ThumbtackCategoryKey,
} from '@/lib/integrations/thumbtack'
import type { WoCategory, CrewRole } from '@/types/database'

const THUMBTACK_ENV_KEYS = [
  'THUMBTACK_ENVIRONMENT', 'THUMBTACK_CLIENT_ID', 'THUMBTACK_CLIENT_SECRET', 'THUMBTACK_UTM_SOURCE',
] as const

function withThumbtackEnv(overrides: Partial<Record<typeof THUMBTACK_ENV_KEYS[number], string>>) {
  for (const key of THUMBTACK_ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
}

const ALL_WO_CATEGORIES: WoCategory[] = [
  'hvac', 'plumbing', 'electrical', 'appliance', 'cleaning', 'landscaping',
  'roofing', 'flooring', 'windows_doors', 'pest_control', 'pool', 'structural',
  'general', 'other',
]
const ALL_CREW_ROLES: CrewRole[] = ['cleaning', 'landscaping', 'maintenance', 'general']

describe('buildRequestFlowUrl', () => {
  it('builds the exact query shape from Thumbtack\'s Request Flow Widget doc', () => {
    const url = buildRequestFlowUrl({
      environment: 'https://thumbtack.com',
      categoryPk:  'cat_123',
      servicePk:   'svc_456',
      zipCode:     '90210',
      utmSource:   'cma-fieldstay',
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://thumbtack.com')
    expect(parsed.pathname).toBe('/embed/request-flow')
    expect(parsed.searchParams.get('category_pk')).toBe('cat_123')
    expect(parsed.searchParams.get('service_pk')).toBe('svc_456')
    expect(parsed.searchParams.get('zip_code')).toBe('90210')
    expect(parsed.searchParams.get('utm_medium')).toBe('partnerships')
    expect(parsed.searchParams.get('utm_source')).toBe('cma-fieldstay')
  })

  it('omits zip_code when not provided, rather than sending an empty param', () => {
    const url = buildRequestFlowUrl({
      environment: 'https://thumbtack.com',
      categoryPk:  'cat_123',
      servicePk:   'svc_456',
      utmSource:   'cma-fieldstay',
    })
    expect(new URL(url).searchParams.has('zip_code')).toBe(false)
  })

  it('accepts extra utm_-prefixed params', () => {
    const url = buildRequestFlowUrl({
      environment:    'https://staging-partner.thumbtack.com',
      categoryPk:     'cat_123',
      servicePk:      'svc_456',
      utmSource:      'cma-fieldstay',
      extraUtmParams: { utm_campaign: 'crew-page' },
    })
    expect(new URL(url).searchParams.get('utm_campaign')).toBe('crew-page')
  })

  it('rejects a non-utm_-prefixed extra param rather than silently sending it', () => {
    expect(() => buildRequestFlowUrl({
      environment:    'https://thumbtack.com',
      categoryPk:     'cat_123',
      servicePk:      'svc_456',
      utmSource:      'cma-fieldstay',
      extraUtmParams: { campaign: 'crew-page' },
    })).toThrow(/utm_-prefixed/)
  })
})

describe('isThumbtackConfigured', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(THUMBTACK_ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of THUMBTACK_ENV_KEYS) delete process.env[k]
  })
  afterEach(() => {
    for (const k of THUMBTACK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is false when none of the four env vars are set', () => {
    expect(isThumbtackConfigured()).toBe(false)
  })

  it('is false when only some of the four are set', () => {
    withThumbtackEnv({ THUMBTACK_ENVIRONMENT: 'https://thumbtack.com', THUMBTACK_CLIENT_ID: 'id' })
    expect(isThumbtackConfigured()).toBe(false)
  })

  it('is true once all four are set', () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:    'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:      'id',
      THUMBTACK_CLIENT_SECRET:  'secret',
      THUMBTACK_UTM_SOURCE:     'cma-fieldstay',
    })
    expect(isThumbtackConfigured()).toBe(true)
  })
})

describe('THUMBTACK_CATEGORY_MAP', () => {
  it('has an entry for every WoCategory and CrewRole value', () => {
    const keys: ThumbtackCategoryKey[] = [...ALL_WO_CATEGORIES, ...ALL_CREW_ROLES]
    for (const key of keys) {
      expect(THUMBTACK_CATEGORY_MAP, `missing entry for "${key}"`).toHaveProperty(key)
    }
  })

  it('maps every category except "other" to a real category_pk', () => {
    for (const [key, value] of Object.entries(THUMBTACK_CATEGORY_MAP)) {
      if (key === 'other') {
        expect(value, '"other" is deliberately unmapped').toBeNull()
      } else {
        expect(value, `"${key}" should have a category_pk`).toEqual(expect.stringMatching(/^\d+$/))
      }
    }
  })
})

describe('searchThumbtackPros', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(THUMBTACK_ENV_KEYS.map((k) => [k, process.env[k]]))
    // The module's token cache is keyed by authBase and persists across
    // tests (it's real production behavior, not a test artifact) — several
    // tests below reuse 'https://thumbtack.com' as THUMBTACK_ENVIRONMENT, so
    // without this a token cached by an earlier test masks a later test's
    // fetch mock entirely.
    invalidateThumbtackToken('https://auth.thumbtack.com')
    invalidateThumbtackToken('https://staging-auth.thumbtack.com')
  })
  afterEach(() => {
    for (const k of THUMBTACK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.unstubAllGlobals()
  })

  it('throws a clear error when THUMBTACK_ENVIRONMENT is unset or unrecognized', async () => {
    withThumbtackEnv({ THUMBTACK_CLIENT_ID: 'id', THUMBTACK_CLIENT_SECRET: 'secret', THUMBTACK_UTM_SOURCE: 'cma-fieldstay' })
    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/not set to a recognized Thumbtack environment/)
  })

  it('throws a clear error when client credentials are missing, even with a valid environment', async () => {
    withThumbtackEnv({ THUMBTACK_ENVIRONMENT: 'https://thumbtack.com', THUMBTACK_UTM_SOURCE: 'cma-fieldstay' })
    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/THUMBTACK_CLIENT_ID\/THUMBTACK_CLIENT_SECRET/)
  })

  it('fetches a real OAuth token via client_credentials against the resolved auth host, then still throws "not yet implemented"', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://staging-partner.thumbtack.com',
      THUMBTACK_CLIENT_ID:     'test-client-id',
      THUMBTACK_CLIENT_SECRET: 'test-client-secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://staging-auth.thumbtack.com/oauth2/token')
      const body = new URLSearchParams(init.body as string)
      expect(body.get('grant_type')).toBe('client_credentials')
      expect(body.get('client_id')).toBe('test-client-id')
      expect(body.get('client_secret')).toBe('test-client-secret')
      expect(body.has('audience')).toBe(false)
      return new Response(JSON.stringify({ access_token: 'tok_123', expires_in: 3600 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/not yet implemented against https:\/\/staging-api\.thumbtack\.com\/api/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes an audience param only when THUMBTACK_AUDIENCE is set — never guessed', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:     'id',
      THUMBTACK_CLIENT_SECRET: 'secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    process.env.THUMBTACK_AUDIENCE = 'https://api.thumbtack.com'
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string)
      expect(body.get('audience')).toBe('https://api.thumbtack.com')
      return new Response(JSON.stringify({ access_token: 'tok_123', expires_in: 3600 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/not yet implemented/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a clear error when the token endpoint responds with a non-OK status and no parseable body', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:     'bad-id',
      THUMBTACK_CLIENT_SECRET: 'bad-secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/token request failed with 401/)
  })

  it('surfaces Thumbtack\'s documented invalid_client error body (error_description field)', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:     'wrong-env-id',
      THUMBTACK_CLIENT_SECRET: 'wrong-env-secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_description: 'Client authentication failed (e.g., unknown client, no client authentication included, or unsupported authentication method).',
    }), { status: 401 })))

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/Client authentication failed/)
  })

  it('surfaces Thumbtack\'s documented proxy_oauth_failed error body (detail field, no error_description)', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:     'id',
      THUMBTACK_CLIENT_SECRET: 'secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'proxy_oauth_failed',
      detail: "Error: oauth_400:invalid_request: Requested audience 'x' has not been whitelisted by the Auth 2.0 Client.",
    }), { status: 502 })))

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/not been whitelisted/)
  })

  it('invalidateThumbtackToken forces the next call to fetch a fresh token instead of a cached one', async () => {
    withThumbtackEnv({
      THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
      THUMBTACK_CLIENT_ID:     'id',
      THUMBTACK_CLIENT_SECRET: 'secret',
      THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
    })
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'tok_123', expires_in: 3600 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' })).rejects.toThrow(/not yet implemented/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Without invalidating, the cached (unexpired) token would be reused —
    // this is exactly what the second call below would do if invalidation
    // didn't work, so the assertion is that it DOESN'T skip the fetch.
    invalidateThumbtackToken('https://auth.thumbtack.com')
    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' })).rejects.toThrow(/not yet implemented/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
