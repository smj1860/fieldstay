import ICAL from 'ical.js'

export interface ParsedBooking {
  uid:        string
  guestName:  string | null
  start:      Date      // checkin
  end:        Date      // checkout
  status:     'confirmed' | 'cancelled' | 'tentative' | 'blocked'
}

/**
 * Parse a raw iCal string into typed booking objects.
 * Handles Airbnb, VRBO, and standard iCal formats.
 */
export function parseIcalFeed(raw: string): ParsedBooking[] {
  let jcalData: unknown
  try {
    jcalData = ICAL.parse(raw)
  } catch {
    throw new Error('Failed to parse iCal data — invalid format')
  }

  const component = new ICAL.Component(jcalData as string | unknown[])
  const vevents   = component.getAllSubcomponents('vevent')

  const results: ParsedBooking[] = []

  for (const vevent of vevents) {
    try {
      const event = new ICAL.Event(vevent)

      const uid     = event.uid
      if (!uid) continue

      const start   = event.startDate?.toJSDate()
      const end     = event.endDate?.toJSDate()
      if (!start || !end) continue

      // Normalise status
      const rawStatus = (vevent.getFirstPropertyValue('status') as string | null)?.toUpperCase()
      let status: ParsedBooking['status'] = 'confirmed'
      if (rawStatus === 'CANCELLED') status = 'cancelled'
      else if (rawStatus === 'TENTATIVE') status = 'tentative'

      // Airbnb marks blocked-off dates with "Not available" or "Airbnb (Not available)"
      const summary = event.summary ?? ''
      if (
        summary.toLowerCase().includes('not available') ||
        summary.toLowerCase().includes('reserved') ||
        summary.toLowerCase() === 'blocked'
      ) {
        status = 'blocked'
      }

      // Extract guest name from summary — platforms vary
      // Airbnb: "RESERVED" or guest name
      // VRBO:   "Reservation - [name]"
      let guestName: string | null = null
      if (status === 'confirmed') {
        const cleaned = summary
          .replace(/^reservation\s*-?\s*/i, '')
          .replace(/\s*\(confirmed\)/i, '')
          .trim()
        if (cleaned && cleaned.toLowerCase() !== 'reserved') {
          guestName = cleaned || null
        }
      }

      results.push({ uid, guestName, start, end, status })
    } catch {
      // Skip malformed events — don't blow up the whole sync
      continue
    }
  }

  return results
}

function asDate(d: Date | string): Date {
  return typeof d === 'string' ? new Date(d) : d
}

/**
 * Convert a Date (or ISO string from step.run serialization) to YYYY-MM-DD.
 */
export function toDateString(d: Date | string): string {
  return asDate(d).toISOString().slice(0, 10)
}

/**
 * Convert a Date (or ISO string) to a time string (HH:MM).
 */
export function toTimeString(d: Date | string): string {
  return asDate(d).toISOString().slice(11, 16)
}

/**
 * Returns true if this event is an all-day event (midnight UTC start).
 */
export function isAllDay(d: Date | string): boolean {
  const dt = asDate(d)
  return dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0
}
