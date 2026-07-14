/**
 * Timezone utilities for FieldStay.
 *
 * All three functions use native Intl APIs (Node 20+, no third-party lib).
 * `properties.timezone` is the IANA identifier (e.g. "America/Chicago") that
 * drives every UTC conversion in the codebase.
 */

/**
 * Converts a property's local wall-clock date+time to a UTC Date.
 *
 * Used by the turnover generator to correctly populate `checkout_datetime`
 * and `checkin_datetime` as true UTC timestamps rather than naively treating
 * local time as UTC.
 *
 * @param date     YYYY-MM-DD  (from bookings.checkout_date / checkin_date)
 * @param time     HH:MM       (from bookings.checkout_time / checkin_time)
 * @param timezone IANA string (from properties.timezone)
 *
 * @example
 *   // Chicago property, 11:00 AM checkout on July 6 2026
 *   propertyLocalToUtc('2026-07-06', '11:00', 'America/Chicago')
 *   // → 2026-07-06T16:00:00.000Z  (CDT = UTC-5)
 */
export function propertyLocalToUtc(
  date:     string,
  time:     string,
  timezone: string
): Date {
  const [year, month, day]   = date.split('-').map(Number)
  const [hours, minutes]     = time.split(':').map(Number)

  // Step 1 — Build a naive UTC Date using the same numeric values as the local time.
  //           This is intentionally "wrong" — it gives us a UTC anchor point.
  const naiveUtc = new Date(Date.UTC(
    year!,
    month! - 1,
    day!,
    hours!,
    minutes!,
    0,
    0,
  ))

  // Step 2 — Ask Intl what local date/time that naive UTC represents in the target
  //           timezone. en-CA gives "YYYY-MM-DD, HH:MM:SS" — easy to parse.
  const localStr = naiveUtc.toLocaleString('en-CA', {
    timeZone:  timezone,
    year:      'numeric',
    month:     '2-digit',
    day:       '2-digit',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
    hour12:    false,
  })

  // Step 3 — Parse that local string back to a Date (treated as UTC).
  //           en-CA format: "YYYY-MM-DD, HH:MM:SS"
  const localAsUtc = new Date(localStr.replace(', ', 'T') + 'Z')

  // Step 4 — The offset is the difference between the naive UTC and local UTC.
  //           Apply it to get the true UTC time for the local date/time.
  const offsetMs = naiveUtc.getTime() - localAsUtc.getTime()
  return new Date(naiveUtc.getTime() + offsetMs)
}

/**
 * Formats a wall-clock time string in the property's local timezone for
 * display to guests, crew members, and vendors.
 *
 * @param naiveTime  HH:MM  (e.g. "15:00" from bookings.checkin_time)
 * @param date       YYYY-MM-DD  (the date on which this time occurs — DST-aware)
 * @param timezone   IANA string (from properties.timezone)
 * @param format     'short' → "3:00 PM"  |  'long' → "3:00 PM CDT"
 *
 * @example
 *   formatPropertyTime('15:00', '2026-07-06', 'America/Chicago', 'long')
 *   // → "3:00 PM CDT"
 */
export function formatPropertyTime(
  naiveTime: string,
  date:      string,
  timezone:  string,
  format:    'short' | 'long' = 'short'
): string {
  const utc = propertyLocalToUtc(date, naiveTime, timezone)
  return utc.toLocaleTimeString('en-US', {
    timeZone:      timezone,
    hour:          'numeric',
    minute:        '2-digit',
    timeZoneName:  format === 'long' ? 'short' : undefined,
  })
}

/**
 * Returns the current moment expressed as a local Date object for the property.
 * Used by Friction Forecaster and cron jobs to reason about whether "now" is
 * before or after a checkout/checkin in the property's local timezone.
 *
 * @example
 *   propertyLocalNow('America/Chicago')
 *   // → Date object representing the current CDT wall-clock time
 */
export function propertyLocalNow(timezone: string): Date {
  const localStr = new Date().toLocaleString('en-CA', {
    timeZone: timezone,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  })
  return new Date(localStr.replace(', ', 'T') + 'Z')
}

/**
 * Formats a vendor work window for same-day flip dispatch communications.
 * Returns a human-readable string like "11:00 AM – 3:00 PM CDT".
 *
 * @param checkoutTime  HH:MM  (booking checkout time — window start)
 * @param checkinTime   HH:MM  (next booking checkin time — window end)
 * @param date          YYYY-MM-DD  (the flip date)
 * @param timezone      IANA string (from properties.timezone)
 */
export function formatVendorWindow(
  checkoutTime: string,
  checkinTime:  string,
  date:         string,
  timezone:     string
): string {
  const start = formatPropertyTime(checkoutTime, date, timezone, 'short')
  const end   = formatPropertyTime(checkinTime,  date, timezone, 'long')
  return `${start} – ${end}`
}

/**
 * Formats a stored UTC ISO timestamp (e.g. turnovers.checkout_datetime) in
 * a property's local timezone for display — the counterpart to
 * propertyLocalToUtc() on the way back out. Use this anywhere a
 * property-anchored timestamp (checkout, check-in) is shown to a crew
 * member or PM; formatDateTime() in lib/utils.ts is timezone-naive
 * (formats in the viewer's runtime timezone) and should NOT be used for
 * these fields — see CLAUDE_HOSPITABLE_DEXIE_AUDIT_FIXES_1.md Task 5.
 *
 * @param isoUtc     Full ISO UTC timestamp (e.g. turnover.checkout_datetime)
 * @param timezone   IANA string (from properties.timezone)
 *
 * @example
 *   formatPropertyDateTime('2026-07-06T16:00:00.000Z', 'America/Chicago')
 *   // → "Jul 6, 2026, 11:00 AM CDT"
 */
export function formatPropertyDateTime(isoUtc: string, timezone: string): string {
  return new Date(isoUtc).toLocaleString('en-US', {
    timeZone:     timezone,
    month:        'short',
    day:          'numeric',
    year:         'numeric',
    hour:         'numeric',
    minute:       '2-digit',
    timeZoneName: 'short',
  })
}
