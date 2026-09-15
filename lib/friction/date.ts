import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

/**
 * The operating day for friction scoring, in Central Time.
 *
 * Shared by the cron that WRITES pre_flight_friction.turnover_date and the
 * dashboard panel that READS it, because the two must name the same day.
 *
 * The /ops page's own `todayIso` is `new Date().toISOString().split('T')[0]` —
 * a UTC date. From about 7pm CT onward that is already tomorrow, so a panel
 * keyed off it would query a date the 2am run has not written yet and show a
 * clean dashboard for a day with flagged turnovers still on it. No error, no
 * symptom, exactly the hours a PM is most likely to be checking.
 *
 * Not in lib/scoring/friction.ts on purpose: that module is pure scoring maths
 * with no notion of where the business is.
 */
export const FRICTION_TIMEZONE = 'America/Chicago'

/** YYYY-MM-DD in Central Time. `en-CA` formats ISO-ordered, so no reassembly. */
export function frictionDateString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FRICTION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * A YYYY-MM-DD string as a LOCAL midnight Date.
 *
 * `new Date('2026-07-04')` parses as UTC midnight, which is July 3rd in every
 * US timezone — so every calendar component (weekend, holiday, seasonal,
 * spring break) would be computed against the wrong day for exactly the kind
 * of date this feature exists to flag.
 */
export function localDateFrom(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}

/**
 * UTC instant bounds `[start, end)` for a YYYY-MM-DD calendar day in
 * FRICTION_TIMEZONE — for querying a `timestamptz` column (e.g.
 * `checkout_datetime`) against the actual Chicago day `frictionDateString()`
 * named, not the UTC day with the same digits.
 *
 * String-concatenating `Z` onto a Chicago-formatted date (`` `${ymd}T00:00:00Z` ``)
 * is the exact bug `localDateFrom()`'s docstring already warns about, one file
 * over: it tells Postgres those digits are UTC midnight, which is 5-6 hours
 * off from real Chicago midnight (CDT/CST), so the query window silently
 * misses late-evening turnovers and mis-dates early-evening ones. dayjs.tz()
 * resolves the real UTC offset in effect on that specific date (DST-aware),
 * rather than assuming a fixed one.
 */
export function frictionDayUtcBounds(ymd: string): { startUtc: string; endUtc: string } {
  const start = dayjs.tz(ymd, FRICTION_TIMEZONE).startOf('day')
  const end   = start.add(1, 'day')
  return { startUtc: start.utc().toISOString(), endUtc: end.utc().toISOString() }
}
