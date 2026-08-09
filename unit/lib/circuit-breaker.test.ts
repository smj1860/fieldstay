import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/redis', () => {
  const client = { get: vi.fn(), incr: vi.fn(), expire: vi.fn(), del: vi.fn() }
  return {
    getRedis:             () => client,
    getRedisIfConfigured: vi.fn(() => client),
    upstashConfigured:    () => true,
    __client: client,
  }
})

import * as redisModule from '@/lib/redis'
import {
  isCircuitOpen, recordFailure, recordSuccess, CircuitOpenError, CIRCUIT_BREAKER_CONFIG,
} from '@/lib/integrations/circuit-breaker'

const redis = (redisModule as unknown as {
  __client: Record<'get' | 'incr' | 'expire' | 'del', ReturnType<typeof vi.fn>>
}).__client
const getRedisIfConfigured = redisModule.getRedisIfConfigured as ReturnType<typeof vi.fn>

// ============================================================================
// The breaker exists to stop AMPLIFICATION. During a provider outage every
// independent job otherwise calls through, waits out the full timeout, throws,
// and is retried by Inngest's backoff — N orgs x (1 + retries) full-timeout
// round-trips against a service already failing, each holding a step open.
// ============================================================================

describe('circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRedisIfConfigured.mockReturnValue(redis)
  })

  it('stays closed below the threshold', async () => {
    redis.get.mockResolvedValue(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD - 1)
    expect(await isCircuitOpen('kroger')).toBe(false)
  })

  it('opens at the threshold', async () => {
    redis.get.mockResolvedValue(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD)
    expect(await isCircuitOpen('kroger')).toBe(true)
  })

  it('treats a never-seen provider as closed', async () => {
    redis.get.mockResolvedValue(null)
    expect(await isCircuitOpen('telnyx')).toBe(false)
  })

  it('sets the window TTL on the FIRST failure only', async () => {
    // The window must be fixed from the first failure, not slid forward by
    // every subsequent one — otherwise a steady trickle holds the circuit open
    // forever and it can never re-probe.
    redis.incr.mockResolvedValueOnce(1)
    await recordFailure('kroger')
    expect(redis.expire).toHaveBeenCalledWith('circuit:kroger:failures', CIRCUIT_BREAKER_CONFIG.WINDOW_SECONDS)

    vi.clearAllMocks()
    getRedisIfConfigured.mockReturnValue(redis)
    redis.incr.mockResolvedValueOnce(4)
    await recordFailure('kroger')
    expect(redis.expire).not.toHaveBeenCalled()
  })

  it('clears the window on success', async () => {
    await recordSuccess('kroger')
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:failures')
  })

  it('keys per provider, so one outage cannot mute another integration', async () => {
    redis.get.mockResolvedValue(0)
    await isCircuitOpen('kroger')
    await isCircuitOpen('mapbox')
    expect(redis.get).toHaveBeenNthCalledWith(1, 'circuit:kroger:failures')
    expect(redis.get).toHaveBeenNthCalledWith(2, 'circuit:mapbox:failures')
  })

  describe('fails OPEN — a breaker is protection against wasted work, not a correctness barrier', () => {
    it('allows the call when Upstash is unconfigured (every preview deploy)', async () => {
      getRedisIfConfigured.mockReturnValue(null)
      expect(await isCircuitOpen('kroger')).toBe(false)
    })

    it('allows the call when the counter read throws', async () => {
      // Refusing all outbound integration traffic because the counter store is
      // down would turn a Redis blip into a total integration outage.
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'))
      expect(await isCircuitOpen('kroger')).toBe(false)
    })

    it('never throws from recordFailure/recordSuccess', async () => {
      redis.incr.mockRejectedValue(new Error('down'))
      redis.del.mockRejectedValue(new Error('down'))
      await expect(recordFailure('kroger')).resolves.toBeUndefined()
      await expect(recordSuccess('kroger')).resolves.toBeUndefined()
    })

    it('does no Redis work at all when unconfigured', async () => {
      getRedisIfConfigured.mockReturnValue(null)
      await recordFailure('kroger')
      await recordSuccess('kroger')
      expect(redis.incr).not.toHaveBeenCalled()
      expect(redis.del).not.toHaveBeenCalled()
    })
  })

  it('CircuitOpenError names the provider and why the call was skipped', () => {
    const err = new CircuitOpenError('kroger')
    expect(err.provider).toBe('kroger')
    expect(err.message).toContain('kroger')
    expect(err.message).toContain('skipping the call')
  })
})
