import { getRedisIfConfigured } from '@/lib/redis'
import { WEATHER_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'
import { fetchWithRetry } from '@/lib/http/retry'
import { singleFlight } from '@/lib/cache/single-flight'

// Client comes from lib/redis.ts, which reads this project's
// upstash_fieldstay_KV_REST_API_* names rather than the standard
// UPSTASH_REDIS_REST_* ones Redis.fromEnv() expects — fromEnv() logged
// "unable to find environment variable" on every /api/inngest request that
// imports this module even though the credentials were present under the
// real names.
//
// getRedisIfConfigured() rather than getRedis(): this is purely a cache, so
// "no Redis" is a cache miss, not an error. Calling an unconfigured client
// turned every weather lookup in preview into a thrown
// "Failed to parse URL from /pipeline".


export type SlotType =
  | 'morning_brew'
  | 'dinner_pints'
  | 'rainy_day'
  | 'outdoor_adventure'
  | 'general'
  | 'other'

// weatherCode integer → human label mapping (Tomorrow.io standard codes)
export const WEATHER_CODE_MAP: Record<number, string> = {
  1000: 'Clear',
  1001: 'Cloudy',
  1100: 'Mostly Clear',
  1101: 'Partly Cloudy',
  1102: 'Mostly Cloudy',
  2000: 'Fog',
  2100: 'Light Fog',
  4000: 'Drizzle',
  4001: 'Rain',
  4200: 'Light Rain',
  4201: 'Heavy Rain',
  5000: 'Snow',
  5001: 'Flurries',
  5100: 'Light Snow',
  5101: 'Heavy Snow',
  6000: 'Freezing Drizzle',
  6001: 'Freezing Rain',
  6200: 'Light Freezing Rain',
  6201: 'Heavy Freezing Rain',
  7000: 'Ice Pellets',
  7101: 'Heavy Ice Pellets',
  7102: 'Light Ice Pellets',
  8000: 'Thunderstorm',
}

/**
 * The two precipitation thresholds this module classifies on, deliberately
 * adjacent so neither can be tuned without seeing the other.
 *
 * They are not complements — the band between them is neither "rainy" nor
 * "clear", and that gap is intentional: a 30%-chance day should not trigger a
 * rain alert, and it should not promise a guest a good day for a hike either.
 *
 * RAINY is the long-standing value. CLEAR is a starting threshold, not a
 * researched one.
 */
export const RAINY_PRECIP_PROBABILITY = 40
export const CLEAR_PRECIP_PROBABILITY = 25

export interface WeatherContext {
  precipitationProbability: number   // 0–100
  temperature:              number   // Fahrenheit (real temp at 2m)
  temperatureApparent:      number   // Fahrenheit (feels like)
  weatherCode:              number   // Tomorrow.io integer code
  weatherLabel:             string   // Human-readable label from WEATHER_CODE_MAP
  isRainy:                  boolean  // precipitationProbability >= RAINY_PRECIP_PROBABILITY
  isSnowy:                  boolean  // snowIntensity > 0 or weatherCode in snow range
  isHot:                    boolean  // temperature >= 85
  isCold:                   boolean  // temperature <= 45
  fetchedAt:                string
}

const CACHE_TTL_SECONDS = 3600 // 1 hour

const SNOWY_CODES = new Set([5000, 5001, 5100, 5101, 6000, 6001, 6200, 6201, 7000, 7101, 7102])

function getCacheKey(lat: number, lng: number): string {
  // Round to 2 decimal places — collapses nearby coordinates to the same cache entry
  const roundedLat = Math.round(lat * 100) / 100
  const roundedLng = Math.round(lng * 100) / 100
  return `weather:tomorrow:${roundedLat}:${roundedLng}`
}

/**
 * Current conditions for a location, cached in Redis for an hour.
 *
 * Single-flighted. This is read by two PUBLIC guest pages (/g/[slug] and
 * /g/b/[token]) as well as the morning and evening nudge crons, so concurrent
 * misses on the same key are the normal case, not an edge one: the TTL expires
 * at a fixed point for every guest at a property, and a cold key is hit by
 * whatever burst of guests arrives first. Plain cache-aside turned each of
 * those into N identical outbound calls to Tomorrow.io — N times the rate-limit
 * consumption and N x WEATHER_TIMEOUT_MS of blocked render/step time when the
 * provider is slow, which is exactly when the burst happens.
 *
 * The lock lives one layer up in lib/cache/single-flight.ts rather than inline
 * here: two token-refresh paths already had this pattern open-coded, and a
 * third copy is how the first two drift.
 */
export async function getWeatherForLocation(
  lat: number,
  lng: number
): Promise<WeatherContext> {
  const cacheKey = getCacheKey(lat, lng)
  const redis    = getRedisIfConfigured()

  return singleFlight<WeatherContext>({
    key:      cacheKey,
    read:     async () => (redis ? await redis.get<WeatherContext>(cacheKey) : null),
    produce:  () => fetchAndCacheWeather(lat, lng, cacheKey),
    // The producer is bounded by WEATHER_TIMEOUT_MS, so the lock only has to
    // outlive that plus the write.
    lockTtlSeconds: Math.ceil(WEATHER_TIMEOUT_MS / 1000) + 5,
  })
}

/**
 * The uncached fetch. Separate from getWeatherForLocation so the single-flight
 * wrapper has something to call, and so the "produce" half is readable on its
 * own.
 */
async function fetchAndCacheWeather(
  lat:      number,
  lng:      number,
  cacheKey: string,
): Promise<WeatherContext> {
  const redis  = getRedisIfConfigured()
  const apiKey = process.env.TOMORROW_IO_API_KEY
  if (!apiKey) throw new Error('TOMORROW_IO_API_KEY is not configured')

  // Fields param is NOT in the realtime spec — omit it and parse what we need
  // from the full response. units=imperial gives Fahrenheit for temperature fields.
  const url =
    `https://api.tomorrow.io/v4/weather/realtime` +
    `?location=${lat},${lng}` +
    `&units=imperial` +
    `&apikey=${apiKey}`

  // This call sits inside the per-guest nudge SMS send, so an unbounded
  // fetch would hold that send (and its Inngest step) open indefinitely.
  // The timeout is surfaced as its own error message rather than folded
  // into the generic API-error branch — "Tomorrow.io is slow" and
  // "Tomorrow.io said no" are different operational problems.
  let response: Response
  try {
    // Retried: a read-only GET, and it already sits behind a single-flight
    // lock, so the retries are one caller's, not the whole fleet's. Losing
    // this call means the guest nudge goes out without a weather line — worth
    // one more attempt on a 5xx, not worth an outage's worth of them.
    response = await fetchWithRetry(url, {
      headers: {
        // Required per Tomorrow.io OpenAPI spec (accept-encoding: required: true)
        'Accept-Encoding': 'deflate, gzip, br',
      },
      next: { revalidate: 0 }, // never Next.js cache — Redis handles it
    }, {
      timeoutMs: WEATHER_TIMEOUT_MS,
      label:     'tomorrow-io-realtime',
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Tomorrow.io request timed out after ${WEATHER_TIMEOUT_MS}ms`)
    }
    throw err
  }

  if (response.status === 429) {
    throw new Error('Tomorrow.io rate limit exceeded. Check daily/hourly limits.')
  }

  if (!response.ok) {
    throw new Error(
      `Tomorrow.io API error: ${response.status} ${response.statusText}`
    )
  }

  const json = await response.json() as {
    data: {
      values: {
        precipitationProbability: number
        temperature:              number
        temperatureApparent:      number
        weatherCode:              number
        snowIntensity:            number
      }
    }
  }

  const {
    precipitationProbability,
    temperature,
    temperatureApparent,
    weatherCode,
    snowIntensity,
  } = json.data.values

  const context: WeatherContext = {
    precipitationProbability,
    temperature,
    temperatureApparent,
    weatherCode,
    weatherLabel: WEATHER_CODE_MAP[weatherCode] ?? 'Unknown',
    isRainy:      precipitationProbability >= RAINY_PRECIP_PROBABILITY,
    isSnowy:      snowIntensity > 0 || SNOWY_CODES.has(weatherCode),
    isHot:        temperature >= 85,
    isCold:       temperature <= 45,
    fetchedAt:    new Date().toISOString(),
  }

  if (redis) await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(context))
  return context
}

/**
 * A single day's forecast — a deliberately small type, NOT a widened
 * WeatherContext.
 *
 * WeatherContext is read by two public guest pages (/g/[slug], /g/b/[token])
 * and both nudge crons. Bolting optional next-day fields onto it would force
 * every one of those callers to reason about whether they are populated on the
 * value they happen to hold; a separate type cannot be read wrong.
 */
export interface DayForecast {
  precipitationProbability: number   // 0-100
  temperatureMax:           number   // Fahrenheit
  weatherCode:              number   // Tomorrow.io integer code
  weatherLabel:             string   // Human-readable label from WEATHER_CODE_MAP
  isClear:                  boolean  // precipitationProbability < CLEAR_PRECIP_PROBABILITY
  fetchedAt:                string
}

function getForecastCacheKey(lat: number, lng: number, targetDate: string): string {
  // Same 2dp rounding as the realtime key, plus the DATE. Without the date, a
  // forecast fetched at 6pm on the 3rd is served — inside its hour TTL, but a
  // whole day wrong — to the 6pm run on the 4th, which is the one moment this
  // cron actually reads it.
  const roundedLat = Math.round(lat * 100) / 100
  const roundedLng = Math.round(lng * 100) / 100
  return `weather:tomorrow:forecast:${roundedLat}:${roundedLng}:${targetDate}`
}

/**
 * The daily forecast for one calendar date at a location, cached in Redis.
 *
 * ("Tomorrow" is doing double duty here: Tomorrow.io is the provider, and the
 * day this reads is tomorrow's. `targetDate` is passed in rather than derived
 * so the timezone decision stays with the caller, which is the only layer that
 * knows whose day it is.)
 *
 * Deliberately a sibling of getWeatherForLocation rather than an option on it:
 * separate cache key, same singleFlight wrapper, same WEATHER_TIMEOUT_MS bound,
 * same 2dp coordinate rounding. The two are meant to read side by side.
 *
 * @param targetDate YYYY-MM-DD, in whatever timezone the caller cares about.
 */
export async function getTomorrowForecastForLocation(
  lat:        number,
  lng:        number,
  targetDate: string,
): Promise<DayForecast> {
  const cacheKey = getForecastCacheKey(lat, lng, targetDate)
  const redis    = getRedisIfConfigured()

  return singleFlight<DayForecast>({
    key:     cacheKey,
    read:    async () => (redis ? await redis.get<DayForecast>(cacheKey) : null),
    produce: () => fetchAndCacheForecast(lat, lng, targetDate, cacheKey),
    lockTtlSeconds: Math.ceil(WEATHER_TIMEOUT_MS / 1000) + 5,
  })
}

/** Tomorrow.io daily timeline entry — only the fields this module reads. */
interface DailyTimelineEntry {
  time:   string
  values: {
    precipitationProbabilityMax?: number
    precipitationProbabilityAvg?: number
    temperatureMax?:              number
    weatherCodeMax?:              number
    weatherCode?:                 number
  }
}

/**
 * The uncached forecast fetch. Shaped like fetchAndCacheWeather on purpose —
 * same retry, same timeout handling, same 429 branch — so the two are readable
 * as a pair.
 */
async function fetchAndCacheForecast(
  lat:        number,
  lng:        number,
  targetDate: string,
  cacheKey:   string,
): Promise<DayForecast> {
  const redis  = getRedisIfConfigured()
  const apiKey = process.env.TOMORROW_IO_API_KEY
  if (!apiKey) throw new Error('TOMORROW_IO_API_KEY is not configured')

  // timesteps=1d gives one entry per calendar day; units=imperial gives
  // Fahrenheit. No fields param, same as the realtime call — parse what we
  // need out of the full response.
  const url =
    `https://api.tomorrow.io/v4/weather/forecast` +
    `?location=${lat},${lng}` +
    `&timesteps=1d` +
    `&units=imperial` +
    `&apikey=${apiKey}`

  let response: Response
  try {
    response = await fetchWithRetry(url, {
      headers: {
        // Required per Tomorrow.io OpenAPI spec (accept-encoding: required: true)
        'Accept-Encoding': 'deflate, gzip, br',
      },
      next: { revalidate: 0 }, // never Next.js cache — Redis handles it
    }, {
      timeoutMs: WEATHER_TIMEOUT_MS,
      label:     'tomorrow-io-forecast',
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Tomorrow.io forecast request timed out after ${WEATHER_TIMEOUT_MS}ms`)
    }
    throw err
  }

  if (response.status === 429) {
    throw new Error('Tomorrow.io rate limit exceeded. Check daily/hourly limits.')
  }

  if (!response.ok) {
    throw new Error(
      `Tomorrow.io forecast API error: ${response.status} ${response.statusText}`
    )
  }

  const json = await response.json() as {
    timelines?: { daily?: DailyTimelineEntry[] }
  }

  const daily = json.timelines?.daily ?? []

  // Match the requested date rather than indexing [1]: the provider's day
  // boundaries are its own, and silently returning the wrong day is worse than
  // throwing. The caller already treats a throw as "no forecast" and degrades.
  const entry = daily.find((d) => typeof d.time === 'string' && d.time.startsWith(targetDate))
  if (!entry) {
    throw new Error(`Tomorrow.io forecast has no daily entry for ${targetDate}`)
  }

  const precipitationProbability =
    entry.values.precipitationProbabilityMax ?? entry.values.precipitationProbabilityAvg ?? 0
  const weatherCode = entry.values.weatherCodeMax ?? entry.values.weatherCode ?? 0

  const forecast: DayForecast = {
    precipitationProbability,
    temperatureMax: entry.values.temperatureMax ?? 0,
    weatherCode,
    weatherLabel:   WEATHER_CODE_MAP[weatherCode] ?? 'Unknown',
    isClear:        precipitationProbability < CLEAR_PRECIP_PROBABILITY,
    fetchedAt:      new Date().toISOString(),
  }

  if (redis) await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(forecast))
  return forecast
}

/**
 * Returns which slot types are contextually active given the current hour and weather.
 * Fully deterministic — no LLM call at guest render time.
 */
export function getActiveSlotTypes(
  hourOfDay: number,
  weather:   WeatherContext
): Set<SlotType> {
  const active = new Set<SlotType>(['general', 'other'])

  if (hourOfDay >= 7 && hourOfDay < 11) active.add('morning_brew')
  if (hourOfDay >= 17)                  active.add('dinner_pints')

  // Rainy day triggers on rain probability OR active snow
  if (weather.isRainy || weather.isSnowy) active.add('rainy_day')

  // Outdoor adventure: clear conditions, daytime, not raining or snowing
  if (!weather.isRainy && !weather.isSnowy && hourOfDay >= 8 && hourOfDay < 20) {
    active.add('outdoor_adventure')
  }

  return active
}

export function getTimeOfDay(h: number): 'morning' | 'daytime' | 'evening' {
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 17)          return 'evening'
  return 'daytime'
}
