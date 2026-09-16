import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/redis', () => {
  const client = { get: vi.fn(), set: vi.fn(), del: vi.fn() }
  return {
    getRedis:             () => client,
    getRedisIfConfigured: vi.fn(() => client),
    upstashConfigured:    () => true,
    __client: client,
  }
})

import * as redisModule from '@/lib/redis'
import { searchThumbtackPros, invalidateThumbtackToken } from '@/lib/integrations/thumbtack'

const redis = (redisModule as unknown as {
  __client: Record<'get' | 'set' | 'del', ReturnType<typeof vi.fn>>
}).__client
const getRedisIfConfigured = redisModule.getRedisIfConfigured as ReturnType<typeof vi.fn>

// ============================================================================
// A bare in-process Map cached a Thumbtack OAuth token per Vercel function
// instance — fine for one instance, but every concurrent instance
// independently misses and independently exchanges a token at scale-out,
// stampeding Thumbtack's own auth server exactly when traffic (and instance
// count) is highest. getThumbtackAccessToken() now goes through
// singleFlight() with the token cached in Redis, the same shape already
// proven for Tomorrow.io in unit/lib/weather-single-flight.test.ts.
//
// searchThumbtackPros() is the entry point under test — it always throws
// "not yet implemented" past the token fetch (see lib/integrations/
// thumbtack.ts's module header), which is exactly what makes it a clean probe
// here: the token exchange is real and observable, and nothing past it is.
// ============================================================================

const THUMBTACK_ENV_KEYS = [
  'THUMBTACK_ENVIRONMENT', 'THUMBTACK_CLIENT_ID', 'THUMBTACK_CLIENT_SECRET', 'THUMBTACK_UTM_SOURCE',
] as const

function withThumbtackEnv(overrides: Partial<Record<typeof THUMBTACK_ENV_KEYS[number], string>>) {
  for (const key of THUMBTACK_ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
}

let saved: Record<string, string | undefined>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  getRedisIfConfigured.mockReturnValue(redis)
  saved = Object.fromEntries(THUMBTACK_ENV_KEYS.map((k) => [k, process.env[k]]))
  withThumbtackEnv({
    THUMBTACK_ENVIRONMENT:   'https://thumbtack.com',
    THUMBTACK_CLIENT_ID:     'test-client-id',
    THUMBTACK_CLIENT_SECRET: 'test-client-secret',
    THUMBTACK_UTM_SOURCE:    'cma-fieldstay',
  })
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ access_token: 'tok_123', expires_in: 3600 }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const k of THUMBTACK_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
})

async function callOnce() {
  await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
    .rejects.toThrow(/not yet implemented/)
}

describe('getThumbtackAccessToken is single-flighted through Redis', () => {
  it('serves a warm cache without calling Thumbtack\'s token endpoint', async () => {
    redis.get.mockResolvedValue('cached_token')

    await callOnce()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('on a miss, takes a lock keyed to the auth host before exchanging a token', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')

    await callOnce()

    expect(redis.set).toHaveBeenCalledWith(
      'thumbtack:token:https://auth.thumbtack.com:lock', '1',
      { nx: true, ex: expect.any(Number) },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The real token write, distinct from the lock's own `.set(...:lock, '1', ...)`.
    expect(redis.set).toHaveBeenCalledWith(
      'thumbtack:token:https://auth.thumbtack.com', 'tok_123', { ex: 3570 },
    )
    expect(redis.del).toHaveBeenCalledWith('thumbtack:token:https://auth.thumbtack.com:lock')
  })

  it('a concurrent loser makes NO outbound call — it reads what the winner cached', async () => {
    redis.set.mockResolvedValue(null)   // someone else holds the lock
    let reads = 0
    redis.get.mockImplementation(async () => (++reads >= 2 ? 'winner_token' : null))

    await callOnce()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still fetches when Upstash is unconfigured — no cache is a miss, not an error', async () => {
    getRedisIfConfigured.mockReturnValue(null)

    await callOnce()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the token exchange fails, so the next caller is not stuck behind a dead lock', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/token request failed with 401/)
    expect(redis.del).toHaveBeenCalledWith('thumbtack:token:https://auth.thumbtack.com:lock')
  })

  it('does not cache a failed token exchange', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' })).rejects.toThrow()

    expect(redis.set).not.toHaveBeenCalledWith(
      'thumbtack:token:https://auth.thumbtack.com', expect.any(String), expect.anything(),
    )
  })

  it('invalidateThumbtackToken deletes the cached token for that auth host', async () => {
    await invalidateThumbtackToken('https://auth.thumbtack.com')

    expect(redis.del).toHaveBeenCalledWith('thumbtack:token:https://auth.thumbtack.com')
  })

  it('invalidateThumbtackToken is a harmless no-op when Redis is unconfigured', async () => {
    getRedisIfConfigured.mockReturnValue(null)

    await expect(invalidateThumbtackToken('https://auth.thumbtack.com')).resolves.toBeUndefined()
    expect(redis.del).not.toHaveBeenCalled()
  })
})
