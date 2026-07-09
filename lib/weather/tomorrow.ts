import { Redis } from '@upstash/redis'

// Redis.fromEnv() reads the standard UPSTASH_REDIS_REST_URL/_TOKEN names,
// which this project doesn't use — see lib/rate-limit.ts's matching
// upstash_fieldstay_KV_REST_API_* vars. fromEnv() logged "unable to find
// environment variable" warnings on every /api/inngest request that
// imports this module even though the actual credentials were present
// under the real names.
const redis = new Redis({
  url:   process.env.upstash_fieldstay_KV_REST_API_URL!,
  token: process.env.upstash_fieldstay_KV_REST_API_TOKEN!,
})

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

export interface WeatherContext {
  precipitationProbability: number   // 0–100
  temperature:              number   // Fahrenheit (real temp at 2m)
  temperatureApparent:      number   // Fahrenheit (feels like)
  weatherCode:              number   // Tomorrow.io integer code
  weatherLabel:             string   // Human-readable label from WEATHER_CODE_MAP
  isRainy:                  boolean  // precipitationProbability >= 40
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

export async function getWeatherForLocation(
  lat: number,
  lng: number
): Promise<WeatherContext> {
  const cacheKey = getCacheKey(lat, lng)

  const cached = await redis.get<WeatherContext>(cacheKey)
  if (cached) return cached

  const apiKey = process.env.TOMORROW_IO_API_KEY
  if (!apiKey) throw new Error('TOMORROW_IO_API_KEY is not configured')

  // Fields param is NOT in the realtime spec — omit it and parse what we need
  // from the full response. units=imperial gives Fahrenheit for temperature fields.
  const url =
    `https://api.tomorrow.io/v4/weather/realtime` +
    `?location=${lat},${lng}` +
    `&units=imperial` +
    `&apikey=${apiKey}`

  const response = await fetch(url, {
    headers: {
      // Required per Tomorrow.io OpenAPI spec (accept-encoding: required: true)
      'Accept-Encoding': 'deflate, gzip, br',
    },
    next: { revalidate: 0 }, // never Next.js cache — Redis handles it
  })

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
    isRainy:      precipitationProbability >= 40,
    isSnowy:      snowIntensity > 0 || SNOWY_CODES.has(weatherCode),
    isHot:        temperature >= 85,
    isCold:       temperature <= 45,
    fetchedAt:    new Date().toISOString(),
  }

  await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(context))
  return context
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
