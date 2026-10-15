// lib/evidence/freeze-watch.ts
//
// The decision half of Freeze Watch. The cron (lib/inngest/functions/cron/
// freeze-watch.ts) loads rows and forecasts; this module says, for one
// property and one night, whether a prep work order is warranted and what it
// should say.
import type { DayForecast } from '@/lib/weather/tomorrow'

export const DEFAULT_FREEZE_THRESHOLD_F = 28
export const MIN_PROOF_PHOTOS           = 2

export interface FreezeCandidateProperty {
  id:                 string
  name:               string | null
  freeze_threshold_f: number | null
  lat:                number | null
  lng:                number | null
}

export interface FreezeDecision {
  fire:      boolean
  reason:    'below_threshold' | 'above_threshold' | 'occupied' | 'no_forecast' | 'open_work_order' | 'no_coordinates'
  threshold: number
  low:       number | null
}

export function effectiveThreshold(p: Pick<FreezeCandidateProperty, 'freeze_threshold_f'>): number {
  return p.freeze_threshold_f ?? DEFAULT_FREEZE_THRESHOLD_F
}

export function decideFreezeWatch(input: {
  property:        FreezeCandidateProperty
  forecast:        Pick<DayForecast, 'temperatureMin'> | null
  occupied:        boolean
  hasOpenFreezeWo: boolean
}): FreezeDecision {
  const threshold = effectiveThreshold(input.property)
  const { property, forecast } = input

  if (property.lat === null || property.lng === null || (property.lat === 0 && property.lng === 0)) {
    return { fire: false, reason: 'no_coordinates', threshold, low: null }
  }
  if (!forecast || forecast.temperatureMin === null || forecast.temperatureMin === undefined) {
    return { fire: false, reason: 'no_forecast', threshold, low: null }
  }
  const low = forecast.temperatureMin
  if (low > threshold)      return { fire: false, reason: 'above_threshold', threshold, low }
  if (input.occupied)       return { fire: false, reason: 'occupied',        threshold, low }
  if (input.hasOpenFreezeWo) return { fire: false, reason: 'open_work_order', threshold, low }
  return { fire: true, reason: 'below_threshold', threshold, low }
}

/** Title and description for the prep work order. No em dashes: this is customer-facing. */
export function freezeWorkOrderCopy(input: {
  propertyName:  string | null
  forecastDate:  string   // YYYY-MM-DD, property-local
  low:           number
  threshold:     number
}): { title: string; description: string } {
  const where = input.propertyName ? ` at ${input.propertyName}` : ''
  const title = `Freeze prep${where}: forecast low ${Math.round(input.low)}°F on ${input.forecastDate}`
  const description = [
    `The forecast low for ${input.forecastDate} is ${Math.round(input.low)}°F, at or below this property's ${input.threshold}°F threshold, and the home is vacant that night.`,
    '',
    'Complete the following and take the listed photos. The photos are the proof of care record for this property.',
    '',
    '1. Set the thermostat to hold at 55°F or above. Photo: thermostat display showing the set point.',
    '2. Open the cabinet doors under every sink on an exterior wall. Photo: one cabinet open.',
    '3. Set a slow drip on the faucet farthest from the water main. Photo: the dripping faucet.',
    '4. Disconnect and drain exterior hoses. Photo: the disconnected spigot.',
    '5. If the property has a well, crawlspace or exposed supply line, confirm heat tape or insulation is in place. Photo if applicable.',
    '',
    `Upload at least ${MIN_PROOF_PHOTOS} photos before marking complete.`,
  ].join('\n')
  return { title, description }
}

export const FREEZE_THRESHOLD_MIN_F = -20
export const FREEZE_THRESHOLD_MAX_F = 45

/**
 * Parses the property form's threshold input. Blank means "use the platform
 * default" (NULL in the column). Anything that is not a whole number inside the
 * column's CHECK range is an error, never silently clamped: a clamped 90 would
 * quietly become a different threshold than the one the PM typed.
 */
export function parseFreezeThreshold(raw: FormDataEntryValue | null): { value: number | null } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { value: null }
  if (!/^-?\d+$/.test(text)) return { error: 'Freeze Watch threshold must be a whole number of degrees.' }
  const n = Number.parseInt(text, 10)
  if (n < FREEZE_THRESHOLD_MIN_F || n > FREEZE_THRESHOLD_MAX_F) {
    return { error: `Freeze Watch threshold must be between ${FREEZE_THRESHOLD_MIN_F}°F and ${FREEZE_THRESHOLD_MAX_F}°F.` }
  }
  return { value: n }
}
