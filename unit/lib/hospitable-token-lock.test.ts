import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// H-1: getValidHospitableToken() must not let two concurrent callers for the
// SAME user interleave a refresh-token exchange — Hospitable rotates refresh
// tokens, so the loser's now-superseded token silently breaks the NEXT
// refresh (up to an hour later, once the 60-min old-token grace expires).
// These tests prove: concurrent callers produce exactly one exchange, a dead
// lock holder is fallen through after the wait ceiling, and a Redis outage
// fails OPEN (proceeds unlocked) rather than blocking every sync.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  redis: { set: vi.fn(), del: vi.fn() },
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken:          vi.fn(),
  readIntegrationRefreshToken:   vi.fn(),
  storeIntegrationToken:         vi.fn(),
  storeIntegrationRefreshToken:  vi.fn(),
}))

import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { createServiceClient } from '@/lib/supabase/server'
import { redis } from '@/lib/rate-limit'
import {
  readIntegrationToken,
  readIntegrationRefreshToken,
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '@/lib/integrations/vault'

const USER_ID = 'user_1'

// Mutable connection state shared across every `.from('integration_connections')`
// call in a test, so a refresh performed by one caller is visible to a
// concurrent caller's later poll.
function makeConnectionState(initialExpiresAt: string) {
  let expiresAt = initialExpiresAt
  return {
    get:     () => expiresAt,
    setFresh: (newExpiresAt: string) => { expiresAt = newExpiresAt },
  }
}

function makeSupabase(state: ReturnType<typeof makeConnectionState>) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.update = () => chain
    chain.eq     = () => chain
    chain.single = () => {
      if (table !== 'integration_connections') return Promise.resolve({ data: null, error: null })
      return Promise.resolve({
        data:  { expires_at: state.get(), external_user_id: 'hosp_ext_1' },
        error: null,
      })
    }
    return chain
  })
  return { from }
}

function mockFetchExchange() {
  return vi.fn(async () => ({
    ok:     true,
    status: 200,
    json:   async () => ({
      access_token:  'new_access_token',
      refresh_token: 'new_refresh_token',
      expires_in:    43200,
      token_type:    'Bearer',
    }),
  }))
}

const FUTURE_EXPIRY  = new Date(Date.now() + 60 * 60 * 1000).toISOString()   // 1h out — no refresh needed
const EXPIRED_EXPIRY = new Date(Date.now() - 60 * 1000).toISOString()       // already expired — refresh needed

describe('getValidHospitableToken — refresh lock (H-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('HOSPITABLE_CLIENT_ID', 'test_client_id')
    vi.stubEnv('HOSPITABLE_CLIENT_SECRET', 'test_client_secret')
    ;(readIntegrationRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValue('current_refresh_token')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('produces exactly one exchange when two concurrent callers race for the same user', async () => {
    vi.useFakeTimers()
    const state = makeConnectionState(EXPIRED_EXPIRY)
    const supabase = makeSupabase(state)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchMock = mockFetchExchange()
    vi.stubGlobal('fetch', fetchMock)

    // First caller to call redis.set acquires the lock ('OK'); every
    // subsequent call loses the race (null) — mirrors real NX semantics
    // without needing a stateful fake Redis.
    ;(redis.set as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('OK')
      .mockResolvedValue(null)

    let tokenServed: string | null = null
    ;(storeIntegrationToken as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      tokenServed = 'new_access_token'
    })
    ;(storeIntegrationRefreshToken as ReturnType<typeof vi.fn>).mockImplementation(async (params: { expiresAt?: string | null }) => {
      state.setFresh(params.expiresAt ?? FUTURE_EXPIRY)
    })
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockImplementation(async () => tokenServed)

    const p1 = getValidHospitableToken(USER_ID)
    const p2 = getValidHospitableToken(USER_ID)

    // Flush the winner's (timer-free) refresh chain, then let the loser's
    // 250ms poll tick fire and observe the now-fresh connection.
    await vi.advanceTimersByTimeAsync(250)

    const [token1, token2] = await Promise.all([p1, p2])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(token1).toBe('new_access_token')
    expect(token2).toBe('new_access_token')
  })

  it('falls through to an unlocked refresh after the wait ceiling when the lock holder never releases', async () => {
    vi.useFakeTimers()
    const state = makeConnectionState(EXPIRED_EXPIRY)
    const supabase = makeSupabase(state)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchMock = mockFetchExchange()
    vi.stubGlobal('fetch', fetchMock)

    // Nobody ever acquires the lock — simulates a holder that crashed
    // mid-refresh and never released it.
    ;(redis.set as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(storeIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(storeIntegrationRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const resultPromise = getValidHospitableToken(USER_ID)

    // 60 waits * 250ms = 15s ceiling
    await vi.advanceTimersByTimeAsync(60 * 250)

    const token = await resultPromise

    expect(token).toBe('new_access_token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('wait ceiling hit'))
  })

  it('fails open (proceeds unlocked, no wait) when Redis itself is unavailable', async () => {
    const state = makeConnectionState(EXPIRED_EXPIRY)
    const supabase = makeSupabase(state)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchMock = mockFetchExchange()
    vi.stubGlobal('fetch', fetchMock)

    ;(redis.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    ;(storeIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(storeIntegrationRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const token = await getValidHospitableToken(USER_ID)

    expect(token).toBe('new_access_token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // acquireRefreshLock's own warning about the lock being unavailable —
    // distinct from the wait-ceiling warning in the previous test.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('refresh lock unavailable'),
      expect.anything(),
    )
  })

  it('fails fast on a terminal invalid_grant response instead of retrying with the same dead token', async () => {
    const state = makeConnectionState(EXPIRED_EXPIRY)
    const supabase = makeSupabase(state)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchMock = vi.fn(async () => ({
      ok:     false,
      status: 400,
      json:   async () => ({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    ;(redis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK')

    await expect(getValidHospitableToken(USER_ID)).rejects.toThrow(/Refresh token revoked/)

    // H-1b: invalid_grant is terminal — the retry loop must break after the
    // FIRST attempt rather than retrying the identical dead token a second time.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refresh at all when the token is already fresh', async () => {
    const state = makeConnectionState(FUTURE_EXPIRY)
    const supabase = makeSupabase(state)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const fetchMock = mockFetchExchange()
    vi.stubGlobal('fetch', fetchMock)
    ;(readIntegrationToken as ReturnType<typeof vi.fn>).mockResolvedValue('still_valid_token')

    const token = await getValidHospitableToken(USER_ID)

    expect(token).toBe('still_valid_token')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })
})
