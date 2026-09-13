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
