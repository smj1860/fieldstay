import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { singleFlight, acquireLock, releaseLock } from '@/lib/cache/single-flight'

const redis = (redisModule as unknown as {
  __client: Record<'get' | 'set' | 'del', ReturnType<typeof vi.fn>>
}).__client
const getRedisIfConfigured = redisModule.getRedisIfConfigured as ReturnType<typeof vi.fn>

// ============================================================================
// The stampede: a cache-aside read has a window between the miss and the write
// in which every other caller also misses, so N concurrent requests for the
// same key produce N identical outbound calls — worst at a TTL boundary, when
// demand for that key is by definition high.
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks()
  getRedisIfConfigured.mockReturnValue(redis)
})

describe('singleFlight', () => {
  it('returns a warm cache without taking a lock at all', async () => {
    const produce = vi.fn()
    const result = await singleFlight({
      key: 'k', read: async () => 'warm', produce,
    })

    expect(result).toBe('warm')
    expect(produce).not.toHaveBeenCalled()
    // The common case must cost one round-trip, not one plus lock traffic.
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('produces exactly once when the caller wins the lock', async () => {
    redis.set.mockResolvedValue('OK')
    const produce = vi.fn(async () => 'fresh')

    expect(await singleFlight({ key: 'k', read: async () => null, produce })).toBe('fresh')
    expect(produce).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledWith('k:lock', '1', { nx: true, ex: expect.any(Number) })
    expect(redis.del).toHaveBeenCalledWith('k:lock')
  })

  it('a LOSER does not produce — it waits and reads what the winner wrote', async () => {
    // The whole point. Losing the lock must not mean making the same call.
    redis.set.mockResolvedValue(null)
    const produce = vi.fn(async () => 'should-not-happen')
    let reads = 0
    const read = vi.fn(async () => (++reads >= 2 ? 'winners-value' : null))

    const result = await singleFlight({ key: 'k', read, produce, waitMs: 1 })

    expect(result).toBe('winners-value')
    expect(produce).not.toHaveBeenCalled()
  })

  it('a loser NEVER releases a lock it does not hold', async () => {
    // Deleting the winner's lock mid-flight would re-open the stampede it is
    // holding closed — the next caller would acquire and make a second call.
    redis.set.mockResolvedValue(null)
    let reads = 0
    await singleFlight({
      key: 'k', waitMs: 1,
      read:    async () => (++reads >= 2 ? 'v' : null),
      produce: async () => 'x',
    })

    expect(redis.del).not.toHaveBeenCalled()
  })

  it('produces anyway once patience runs out — a dead winner must not become an error', async () => {
    redis.set.mockResolvedValue(null)
    const produce = vi.fn(async () => 'fallback')

    const result = await singleFlight({
      key: 'k', read: async () => null, produce, waitMs: 1, maxWaits: 2,
    })

    expect(result).toBe('fallback')
    expect(produce).toHaveBeenCalledTimes(1)
    expect(redis.del).not.toHaveBeenCalled()   // still never held it
  })

  it('releases the lock even when produce throws', async () => {
    redis.set.mockResolvedValue('OK')

    await expect(singleFlight({
      key: 'k', read: async () => null,
      produce: async () => { throw new Error('provider down') },
    })).rejects.toThrow('provider down')

    // A retained lock would silently serialise every later caller behind a
    // 15-second TTL for a call that already failed.
    expect(redis.del).toHaveBeenCalledWith('k:lock')
  })

  it('treats a cached `null` as a miss but a cached `0`/empty string as a hit', async () => {
    // `if (cached)` would re-produce for every falsy-but-real value. The guard
    // is an explicit null/undefined check for that reason.
    redis.set.mockResolvedValue('OK')
    const produce = vi.fn(async () => 999)

    expect(await singleFlight<number>({ key: 'k', read: async () => 0, produce })).toBe(0)
    expect(produce).not.toHaveBeenCalled()
  })

  describe('fails OPEN — a lock is an optimisation, not a correctness barrier', () => {
    it('produces when Upstash is unconfigured (every preview deploy)', async () => {
      getRedisIfConfigured.mockReturnValue(null)
      const produce = vi.fn(async () => 'v')

      expect(await singleFlight({ key: 'k', read: async () => null, produce })).toBe('v')
      expect(produce).toHaveBeenCalledTimes(1)
    })

    it('produces when the SETNX itself throws', async () => {
      // Failing closed here would turn a Redis blip into "no guidebook renders
      // weather and no token refreshes".
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const produce = vi.fn(async () => 'v')

      expect(await singleFlight({ key: 'k', read: async () => null, produce })).toBe('v')
      expect(produce).toHaveBeenCalledTimes(1)
    })
  })
})

describe('acquireLock / releaseLock', () => {
  it('acquires with NX and a TTL so a crashed holder self-heals', async () => {
    redis.set.mockResolvedValue('OK')
    expect(await acquireLock('mine', 42)).toBe(true)
    expect(redis.set).toHaveBeenCalledWith('mine', '1', { nx: true, ex: 42 })
  })

  it('reports a lost race as false', async () => {
    redis.set.mockResolvedValue(null)
    expect(await acquireLock('mine')).toBe(false)
  })

  it('never throws from release', async () => {
    redis.del.mockRejectedValue(new Error('down'))
    await expect(releaseLock('mine')).resolves.toBeUndefined()
  })

  it('does no Redis work at all when unconfigured', async () => {
    getRedisIfConfigured.mockReturnValue(null)
    expect(await acquireLock('mine')).toBe(true)
    await releaseLock('mine')
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
  })
})
