/**
 * Part-of-day windows: the one definition of morning, afternoon and evening.
 *
 * PURE and client-safe, so the crew screen that SETS a window and the scorer
 * that EXCLUDES on one share a definition. Two copies of these boundaries
 * would let a cleaner mark "no mornings" and still be auto-assigned an 11:30
 * checkout, which is precisely the failure the feature exists to prevent.
 *
 * ── Why three named windows and not free times ──
 * Free start/end times would need interval arithmetic in a hard exclusion that
 * runs under autopilot with nobody reviewing it. Three windows are something a
 * PM reads off a screen and a scorer compares with one lookup. The cost is
 * honest: a cleaner free from 2pm has to mark the afternoon off, losing two
 * hours they could have worked. That is the trade, and it is the safe
 * direction to err in.
 *
 * ── Why FRICTION_TIMEZONE ──
 * "Morning" is a local idea. A checkout stored at 15:00Z is 10am in Central
 * and the crew member means 10am. Resolving the hour in UTC would put every
 * afternoon job in the evening bucket for half the portfolio, and would move
 * the boundary twice a year at DST. The timezone module's name is historical;
 * it is the operating timezone of the business.
 */

import { FRICTION_TIMEZONE } from '@/lib/friction/date'

export const PART_OF_DAY_VALUES = ['morning', 'afternoon', 'evening'] as const
export type PartOfDay = (typeof PART_OF_DAY_VALUES)[number]

/**
 * Boundaries, in local hours.
 *
 * Noon and 5pm, because those are the words' ordinary meanings rather than a
 * shift pattern: a cleaner reading "afternoon" on their phone is not
 * consulting a rota. Deliberately NOT tied to checkout/check-in times, which
 * vary per property, since the crew member is describing their own day.
 */
export const AFTERNOON_STARTS_AT_HOUR = 12
export const EVENING_STARTS_AT_HOUR   = 17

/** The local hour (0-23) of an instant, in the operating timezone. */
export function localHourIn(when: Date, timeZone: string = FRICTION_TIMEZONE): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', hour12: false,
  }).format(when)

  // 'en-US' with hour12:false renders midnight as '24' in some ICU versions,
  // which would fall outside every window. Normalised rather than trusted.
  return Number(hour) % 24
}

/** Which window an instant falls in. */
export function partOfDayFor(when: Date, timeZone: string = FRICTION_TIMEZONE): PartOfDay {
  const hour = localHourIn(when, timeZone)
  if (hour < AFTERNOON_STARTS_AT_HOUR) return 'morning'
  if (hour < EVENING_STARTS_AT_HOUR)   return 'afternoon'
  return 'evening'
}

/** True only for a value the database's CHECK constraint would accept. */
export function isPartOfDay(value: unknown): value is PartOfDay {
  return typeof value === 'string' && (PART_OF_DAY_VALUES as readonly string[]).includes(value)
}

/**
 * Whether a crew member is unavailable at `when`, given one availability row.
 *
 * The THREE states the column models, in one place so no caller has to
 * re-derive them (see the migration's header for why there is exactly one
 * spelling of each):
 *   is_available false            → the whole day is off, window irrelevant
 *   is_available true, parts null → available all day
 *   is_available true, parts [..] → off only in those windows
 *
 * A row for a DIFFERENT date is not this function's problem: callers filter by
 * date first, and passing an unrelated row would silently answer about the
 * wrong day.
 */
export function isUnavailableAt(
  row:  { is_available: boolean; unavailable_parts: string[] | null },
  when: Date,
  timeZone: string = FRICTION_TIMEZONE,
): boolean {
  if (!row.is_available) return true
  if (!row.unavailable_parts?.length) return false
  return row.unavailable_parts.includes(partOfDayFor(when, timeZone))
}
