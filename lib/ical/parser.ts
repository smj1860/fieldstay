import ICAL from 'ical.js'
import { reportError } from '@/lib/observability/report-error'

// A malformed VEVENT is skipped rather than allowed to abort the whole feed —
// one bad row must not cost a PM every other booking on the calendar. But a
// silent skip is how a platform quietly changing its iCal format drops
// revenue-bearing bookings with nothing in the logs to show for it. So skips
// are counted, reported once per parse, and escalated to Sentry when the
// skip rate crosses the level that means "this is a format problem, not one
// odd event".
const ANOMALOUS_SKIP_RATIO = 0.2   // >20% of events unparseable
const ANOMALOUS_SKIP_FLOOR = 3     // ...and at least this many, so a 1-of-2 feed isn't noise

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
  let   skipped = 0
  let   firstSkipReason: string | null = null

  for (const vevent of vevents) {
    const parsed = parseVevent(vevent)
    if ('skipReason' in parsed) {
      skipped++
      firstSkipReason ??= parsed.skipReason
      continue
    }
    results.push(parsed)
  }

  reportSkippedEvents(vevents.length, skipped, firstSkipReason)

  return results
}

/**
 * One VEVENT → one booking, or a reason it could not be read. Returning the
 * reason (rather than swallowing it) is what lets the caller tally skips.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical.js ships no exported Component type for a subcomponent
function parseVevent(vevent: any): ParsedBooking | { skipReason: string } {
  try {
    const event = new ICAL.Event(vevent)

    // A VEVENT with no uid or no dates is just as dropped as one that
    // throws — report it the same way rather than letting it vanish.
    const uid = event.uid
    if (!uid) return { skipReason: 'missing uid' }

    const start = event.startDate?.toJSDate()
    const end   = event.endDate?.toJSDate()
    if (!start || !end) return { skipReason: 'missing start or end date' }

    const summary = event.summary ?? ''
    const status  = resolveStatus(vevent, summary)

    return { uid, guestName: extractGuestName(summary, status), start, end, status }
  } catch (err) {
    return { skipReason: err instanceof Error ? err.message : String(err) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see parseVevent
function resolveStatus(vevent: any, summary: string): ParsedBooking['status'] {
  // Airbnb marks blocked-off dates with "Not available" or
  // "Airbnb (Not available)" — this wins over the STATUS property.
  const lower = summary.toLowerCase()
  if (lower.includes('not available') || lower.includes('reserved') || lower === 'blocked') {
    return 'blocked'
  }

  const rawStatus = (vevent.getFirstPropertyValue('status') as string | null)?.toUpperCase()
  if (rawStatus === 'CANCELLED')  return 'cancelled'
  if (rawStatus === 'TENTATIVE')  return 'tentative'
  return 'confirmed'
}

/**
 * Guest name out of the summary — platforms vary.
 *   Airbnb: "RESERVED" (no name) or the guest's name
 *   VRBO:   "Reservation - [name]"
 * Only confirmed stays carry a name worth keeping.
 */
function extractGuestName(summary: string, status: ParsedBooking['status']): string | null {
  if (status !== 'confirmed') return null

  const cleaned = summary
    .replace(/^reservation\s*-?\s*/i, '')
    .replace(/\s*\(confirmed\)/i, '')
    .trim()

  if (!cleaned || cleaned.toLowerCase() === 'reserved') return null
  return cleaned
}

function reportSkippedEvents(
  total: number,
  skipped: number,
  firstSkipReason: string | null
): void {
  if (skipped === 0) return

  // One line per parse, not one per event: a feed with 400 broken events
  // should be one legible signal, not 400 log entries.
  const ratio = total > 0 ? skipped / total : 1
  const context = {
    totalEvents: total,
    skipped,
    skipRatio:   Number(ratio.toFixed(3)),
    // The reason string is iCal structure ("missing uid", a parser message),
    // never guest data — safe to log.
    firstSkipReason,
  }

  if (skipped >= ANOMALOUS_SKIP_FLOOR && ratio > ANOMALOUS_SKIP_RATIO) {
    // This is the "a platform changed its format" shape: enough of the feed
    // is unparseable that real bookings are being lost. Escalate, don't just
    // log — nobody reads a warn line on a background sync.
    console.error('[parseIcalFeed] anomalous share of calendar events unparseable', context)
    reportError(
      new Error(`iCal feed: ${skipped}/${total} events unparseable (${firstSkipReason})`),
      { site: 'lib.ical.parser.parseIcalFeed', extra: context }
    )
    return
  }

  console.warn('[parseIcalFeed] skipped unparseable calendar events', context)
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
