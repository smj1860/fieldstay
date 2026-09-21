// lib/utils/time-of-day.ts
//
// Formatting for a bare `time without time zone` column (properties.checkin_time
// / checkout_time), which arrives from PostgREST as "16:00:00".
//
// Deliberately NOT `import 'server-only'`: a pure string transform with no
// dependencies, used by the guest guidebook (a Client Component) and by the
// morning SMS send (an Inngest step). Same rationale as lib/validation/uuid.ts.
//
// Note these values carry NO timezone — they are wall-clock times at the
// property, which is exactly what a guest wants read back to them ("check-in
// is at 4:00 PM"). Do not run them through Intl with a timeZone; that would
// reinterpret a wall-clock string as an instant and shift it.

/**
 * "16:00:00" → "4:00 PM". Returns null for null/empty/unparseable input so
 * callers can omit the phrase entirely rather than render "check-in is at ."
 */
export function formatTime12h(time: string | null | undefined): string | null {
  if (!time) return null
  const [hourStr, minuteStr] = time.split(':')
  let hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  // Postgres's `time` type accepts the literal '24:00:00' as a valid
  // end-of-day value — plausible from a time picker that allows it, or
  // forwarded verbatim from a PMS import. Without this, hour=24 reads as
  // "PM" (24 >= 12) and formats to "12:00 PM" (noon) instead of midnight —
  // a checkout time shown 12 hours wrong directly to guests.
  if (hour === 24) hour = 0
  const period = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`
}
