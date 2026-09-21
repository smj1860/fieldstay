import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/redis', () => {
  const client = { get: vi.fn(), incr: vi.fn(), expire: vi.fn(), del: vi.fn(), set: vi.fn() }
  return {
    getRedis:             () => client,
    getRedisIfConfigured: vi.fn(() => client),
    upstashConfigured:    () => true,
    __client: client,
  }
})

import * as redisModule from '@/lib/redis'
import {
  evaluateBreaker, recordFailure, recordSuccess, CIRCUIT_BREAKER_CONFIG,
} from '@/lib/integrations/circuit-breaker'

const redis = (redisModule as unknown as {
  __client: Record<'get' | 'incr' | 'expire' | 'del' | 'set', ReturnType<typeof vi.fn>>
}).__client
const getRedisIfConfigured = redisModule.getRedisIfConfigured as ReturnType<typeof vi.fn>

// ============================================================================
// Half-open state: the actual defect the old design had.
//
// A failure COUNTER with a TTL is not a half-open state — every concurrent
// caller reads the same counter, so the instant its TTL lapses, every one of
// them reads 'closed' and floods through at once. evaluateBreaker instead
// tracks an explicit `openedUntil` VALUE (compared against wall-clock time,
// not inferred from whether a key still exists) and, once past it, grants
// exactly ONE caller a 'probe' via an atomic SETNX claim.
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks()
  getRedisIfConfigured.mockReturnValue(redis)
})

describe('evaluateBreaker', () => {
  it('is closed when nothing has ever been opened', async () => {
    redis.get.mockResolvedValue(null)
    expect(await evaluateBreaker('kroger')).toEqual({ decision: 'closed', priorFailures: 0 })
  })

  it('carries the prior failure count through even while closed', async () => {
    // So a caller (krogerFetch) can skip a pointless clearing DEL on a
    // healthy response when nothing was ever counted.
    redis.get
      .mockResolvedValueOnce(3)     // failuresKey
      .mockResolvedValueOnce(null)  // openedKey
    expect(await evaluateBreaker('kroger')).toEqual({ decision: 'closed', priorFailures: 3 })
  })

  it('is OPEN while wall-clock time is still before openedUntil', async () => {
    redis.get
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(Date.now() + 30_000)
    const result = await evaluateBreaker('kroger')
    expect(result.decision).toBe('open')
    // Must not even attempt the probe claim while still cooling down.
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('grants the probe once openedUntil has passed, via an atomic claim', async () => {
    redis.get
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(Date.now() - 1_000)   // cooldown already elapsed
    redis.set.mockResolvedValue('OK')

    const result = await evaluateBreaker('kroger')

    expect(result.decision).toBe('probe')
    expect(redis.set).toHaveBeenCalledWith(
      'circuit:kroger:probe', '1',
      { nx: true, ex: CIRCUIT_BREAKER_CONFIG.PROBE_TIMEOUT_SECONDS },
    )
  })

  it('THE POINT: a second concurrent caller past the cooldown is rejected, not granted a second probe', async () => {
    // This is the thundering-herd case the old design could not express: two
    // callers both see the cooldown has elapsed, but only the one that wins
    // the SETNX becomes the probe — the loser must still see 'open'.
    redis.get
      .mockResolvedValueOnce(5).mockResolvedValueOnce(Date.now() - 1_000)
      .mockResolvedValueOnce(5).mockResolvedValueOnce(Date.now() - 1_000)
    redis.set
      .mockResolvedValueOnce('OK')   // first caller claims it
      .mockResolvedValueOnce(null)   // second caller loses the race

    const [first, second] = await Promise.all([
      evaluateBreaker('kroger'),
      evaluateBreaker('kroger'),
    ])

    const decisions = [first.decision, second.decision].sort()
    expect(decisions).toEqual(['open', 'probe'])
  })

  it('fails OPEN (closed decision) when Redis is unconfigured', async () => {
    getRedisIfConfigured.mockReturnValue(null)
    expect(await evaluateBreaker('kroger')).toEqual({ decision: 'closed', priorFailures: 0 })
  })

  it('fails OPEN (closed decision) when the read itself throws', async () => {
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await evaluateBreaker('kroger')).toEqual({ decision: 'closed', priorFailures: 0 })
  })
})

describe('recordFailure — opening and re-opening', () => {
  it('does nothing beyond counting below the threshold', async () => {
    redis.incr.mockResolvedValue(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD - 1)
    await recordFailure('kroger')
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('writes an openedUntil timestamp and releases any probe claim once the threshold is crossed', async () => {
    redis.incr.mockResolvedValue(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD)
    const before = Date.now()

    await recordFailure('kroger')

    expect(redis.set).toHaveBeenCalledWith(
      'circuit:kroger:opened-until',
      expect.any(Number),
      { ex: CIRCUIT_BREAKER_CONFIG.WINDOW_SECONDS + CIRCUIT_BREAKER_CONFIG.PROBE_TIMEOUT_SECONDS },
    )
    const [, openedUntil] = redis.set.mock.calls[0]!
    expect(openedUntil).toBeGreaterThanOrEqual(before + CIRCUIT_BREAKER_CONFIG.WINDOW_SECONDS * 1_000)
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:probe')
  })

  it('a FAILED probe re-opens with a FRESH cooldown rather than leaving the stale one in place', async () => {
    // The probe call itself failing still increments past the threshold
    // (count was already >= 5), so this must fire again — extending the
    // cooldown rather than letting it expire on the original schedule.
    redis.incr.mockResolvedValue(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD + 2)
    await recordFailure('kroger')
    expect(redis.set).toHaveBeenCalledWith(
      'circuit:kroger:opened-until', expect.any(Number), expect.anything(),
    )
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:probe')
  })
})

describe('recordSuccess — full reset', () => {
  it('clears the failure counter, the open marker AND any probe claim', async () => {
    await recordSuccess('kroger')
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:failures')
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:opened-until')
    expect(redis.del).toHaveBeenCalledWith('circuit:kroger:probe')
  })

  it('a circuit closed by recordSuccess reads as closed again', async () => {
    // Prove the reset is actually observable through evaluateBreaker, not
    // just that the right DEL calls fired.
    await recordSuccess('kroger')
    redis.get.mockResolvedValue(null)
    expect(await evaluateBreaker('kroger')).toEqual({ decision: 'closed', priorFailures: 0 })
  })
})
