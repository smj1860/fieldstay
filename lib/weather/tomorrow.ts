import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

export type SlotType =
  | 'morning_brew'
  | 'dinner_pints'
  | 'rainy_day'
  | 'outdoor_adventure'
  | 'general'
  | 'other'

export interface WeatherContext {
  precipitationProbability: number  // 0–100
  temperature:              number  // Fahrenheit
  isRainy:                  boolean // precipitationProbability >= 40
  isHot:                    boolean // temperature >= 85
  isCold:                   boolean // temperature <= 45
  fetchedAt:                string
}

const CACHE_TTL_SECONDS = 3600 // 1 hour

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

  const url =
    `https://api.tomorrow.io/v4/weather/realtime` +
    `?location=${lat},${lng}` +
    `&fields=precipitationProbability,temperature` +
    `&units=imperial` +
    `&apikey=${apiKey}`

  const response = await fetch(url, { next: { revalidate: 0 } })

  if (!response.ok) {
    throw new Error(
      `Tomorrow.io API error: ${response.status} ${response.statusText}`
    )
  }

  const json = await response.json() as {
    data: { values: { precipitationProbability: number; temperature: number } }
  }

  const { precipitationProbability, temperature } = json.data.values

  const context: WeatherContext = {
    precipitationProbability,
    temperature,
    isRainy:   precipitationProbability >= 40,
    isHot:     temperature >= 85,
    isCold:    temperature <= 45,
    fetchedAt: new Date().toISOString(),
  }

  await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(context))
  return context
}

/**
 * Deterministic — no LLM call at guest render time. Returns which slot
 * types are contextually active given the current hour and weather.
 */
export function getActiveSlotTypes(
  hourOfDay: number,
  weather:   WeatherContext
): Set<SlotType> {
  const active = new Set<SlotType>(['general', 'other'])

  if (hourOfDay >= 7 && hourOfDay < 11)                     active.add('morning_brew')
  if (hourOfDay >= 17)                                       active.add('dinner_pints')
  if (weather.isRainy)                                       active.add('rainy_day')
  if (!weather.isRainy && hourOfDay >= 8 && hourOfDay < 20) active.add('outdoor_adventure')

  return active
}

export function getTimeOfDay(h: number): 'morning' | 'daytime' | 'evening' {
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 17)          return 'evening'
  return 'daytime'
}
