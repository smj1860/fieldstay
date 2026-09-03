import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/redis', () => {
  const client = { get: vi.fn(), set: vi.fn(), del: vi.fn(), setex: vi.fn() }
  return {
    getRedis:             () => client,
    getRedisIfConfigured: vi.fn(() => client),
    upstashConfigured:    () => true,
    __client: client,
  }
})

import * as redisModule from '@/lib/redis'
import { getWeatherForLocation, getTomorrowForecastForLocation } from '@/lib/weather/tomorrow'

const redis = (redisModule as unknown as {
  __client: Record<'get' | 'set' | 'del' | 'setex', ReturnType<typeof vi.fn>>
}).__client
const getRedisIfConfigured = redisModule.getRedisIfConfigured as ReturnType<typeof vi.fn>

// ============================================================================
// Does getWeatherForLocation actually go THROUGH the single flight?
//
// unit/lib/single-flight.test.ts tests the helper in isolation. That is not
// the same as this call site using it — and this is the call site that matters:
// two PUBLIC guest pages (/g/[slug], /g/b/[token]) read it on render, so
// concurrent misses on one key are the normal case. A fix nothing fails
// without is not a verified fix.
// ============================================================================

const OK_BODY = {
  data: {
    values: {
      precipitationProbability: 10,
      temperature:              72,
      temperatureApparent:      70,
      weatherCode:              1000,
      snowIntensity:            0,
    },
  },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  getRedisIfConfigured.mockReturnValue(redis)
  process.env.TOMORROW_IO_API_KEY = 'test-key'
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => OK_BODY }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('getWeatherForLocation is single-flighted', () => {
  it('serves a warm cache without touching Tomorrow.io or the lock', async () => {
    redis.get.mockResolvedValue({ temperature: 68, weatherLabel: 'Clear' })

    const result = await getWeatherForLocation(30.27, -97.74)

    expect(result).toMatchObject({ temperature: 68 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('takes a lock keyed to the ROUNDED coordinate before calling out on a miss', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')

    await getWeatherForLocation(30.2711, -97.7437)

    // Coordinates round to 2dp so nearby properties share one cache entry —
    // and therefore one lock, which is what makes the de-duplication actually
    // collapse a burst rather than just narrow it.
    expect(redis.set).toHaveBeenCalledWith(
      'weather:tomorrow:30.27:-97.74:lock', '1',
      { nx: true, ex: expect.any(Number) },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(redis.setex).toHaveBeenCalledWith('weather:tomorrow:30.27:-97.74', 3600, expect.any(String))
    expect(redis.del).toHaveBeenCalledWith('weather:tomorrow:30.27:-97.74:lock')
  })

  it('a concurrent loser makes NO outbound call — it reads what the winner cached', async () => {
    // The finding: N concurrent misses used to be N Tomorrow.io calls, N times
    // the rate-limit consumption, and N x the timeout budget of blocked render
    // time when the provider is slow.
    redis.set.mockResolvedValue(null)   // someone else holds it
    let reads = 0
    redis.get.mockImplementation(async () =>
      ++reads >= 2 ? { temperature: 55, weatherLabel: 'Rain' } : null)

    const result = await getWeatherForLocation(30.27, -97.74)

    expect(result).toMatchObject({ temperature: 55 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still fetches when Upstash is unconfigured — no cache is a miss, not an error', async () => {
    getRedisIfConfigured.mockReturnValue(null)

    const result = await getWeatherForLocation(30.27, -97.74)

    expect(result.temperature).toBe(72)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when Tomorrow.io fails, so the next caller is not stuck behind a dead lock', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) })

    await expect(getWeatherForLocation(30.27, -97.74)).rejects.toThrow(/Tomorrow\.io API error/)
    expect(redis.del).toHaveBeenCalledWith('weather:tomorrow:30.27:-97.74:lock')
  })

  it('does not cache a failed lookup', async () => {
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
    fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) })

    await expect(getWeatherForLocation(30.27, -97.74)).rejects.toThrow(/rate limit/)
    expect(redis.setex).not.toHaveBeenCalled()
  })
})

// ============================================================================
// getTomorrowForecastForLocation — the next-day sibling.
//
// Deliberately a separate function and a separate cache key rather than extra
// optional fields on WeatherContext, which two PUBLIC guest pages read.
// ============================================================================

const FORECAST_BODY = {
  timelines: {
    daily: [
      { time: '2026-07-22T11:00:00Z', values: { precipitationProbabilityMax: 90, temperatureMax: 66, weatherCodeMax: 4001 } },
      { time: '2026-07-23T11:00:00Z', values: { precipitationProbabilityMax: 10, temperatureMax: 84, weatherCodeMax: 1000 } },
    ],
  },
}

describe('getTomorrowForecastForLocation', () => {
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => FORECAST_BODY }))
    vi.stubGlobal('fetch', fetchMock)
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
  })

  it('returns the entry for the requested date, not simply the second one', async () => {
    const forecast = await getTomorrowForecastForLocation(30.27, -97.74, '2026-07-23')

    expect(forecast).toMatchObject({
      precipitationProbability: 10,
      temperatureMax:           84,
      weatherCode:              1000,
      weatherLabel:             'Clear',
      isClear:                  true,
    })
  })

  it('keys the cache on the DATE as well as the rounded coordinates', async () => {
    // Without the date, a forecast fetched at 6pm on the 22nd is served — still
    // inside its hour TTL, but a whole day wrong — to the 6pm run on the 23rd,
    // which is the only moment this is ever read.
    await getTomorrowForecastForLocation(30.2711, -97.7437, '2026-07-23')

    expect(redis.setex).toHaveBeenCalledWith(
      'weather:tomorrow:forecast:30.27:-97.74:2026-07-23', 3600, expect.any(String),
    )
    expect(redis.set).toHaveBeenCalledWith(
      'weather:tomorrow:forecast:30.27:-97.74:2026-07-23:lock', '1',
      { nx: true, ex: expect.any(Number) },
    )
  })

  it('does not report a rainy day as clear', async () => {
    const forecast = await getTomorrowForecastForLocation(30.27, -97.74, '2026-07-22')

    expect(forecast.precipitationProbability).toBe(90)
    expect(forecast.isClear).toBe(false)
  })

  it('treats the band between the clear and rainy thresholds as neither', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ timelines: { daily: [
        { time: '2026-07-23T11:00:00Z', values: { precipitationProbabilityMax: 30, temperatureMax: 75, weatherCodeMax: 1101 } },
      ] } }),
    })

    const forecast = await getTomorrowForecastForLocation(30.27, -97.74, '2026-07-23')

    // 30% is under the 40% rain threshold and over the 25% clear one: no rain
    // alert, and no promise of a good day to be outdoors either.
    expect(forecast.isClear).toBe(false)
  })

  it('throws rather than silently serving the wrong day when the date is absent', async () => {
    await expect(getTomorrowForecastForLocation(30.27, -97.74, '2026-08-01'))
      .rejects.toThrow(/no daily entry for 2026-08-01/)
    expect(redis.setex).not.toHaveBeenCalled()
  })

  it('serves a warm cache without calling Tomorrow.io', async () => {
    redis.get.mockResolvedValue({ precipitationProbability: 5, isClear: true, temperatureMax: 80 })

    const forecast = await getTomorrowForecastForLocation(30.27, -97.74, '2026-07-23')

    expect(forecast).toMatchObject({ isClear: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('releases the lock when the provider fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) })

    await expect(getTomorrowForecastForLocation(30.27, -97.74, '2026-07-23'))
      .rejects.toThrow(/Tomorrow\.io forecast API error/)
    expect(redis.del).toHaveBeenCalledWith('weather:tomorrow:forecast:30.27:-97.74:2026-07-23:lock')
  })
})
