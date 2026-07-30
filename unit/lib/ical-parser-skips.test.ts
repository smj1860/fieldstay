import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { parseIcalFeed } from '@/lib/ical/parser'
import { reportError } from '@/lib/observability/report-error'

// Before the 2026-07-30 audit an unparseable VEVENT was dropped by a bare
// `catch { continue }` — no log, no tally. A platform changing its iCal
// format would have silently dropped revenue-bearing bookings with nothing
// anywhere to show for it.

function feed(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n')
}

function vevent(uid: string | null, withDates = true): string {
  return [
    'BEGIN:VEVENT',
    ...(uid ? [`UID:${uid}`] : []),
    ...(withDates ? ['DTSTART;VALUE=DATE:20260801', 'DTEND;VALUE=DATE:20260805'] : []),
    'SUMMARY:Guest Stay',
    'END:VEVENT',
  ].join('\r\n')
}

describe('parseIcalFeed — skipped-event visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('parses good events and logs nothing when none are skipped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const bookings = parseIcalFeed(feed([vevent('a'), vevent('b')]))

    expect(bookings).toHaveLength(2)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })

  it('counts a dropped event and logs ONE line for the whole parse', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const bookings = parseIcalFeed(feed([vevent('a'), vevent(null), vevent('c'), vevent('d')]))

    expect(bookings).toHaveLength(3)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[parseIcalFeed] skipped unparseable calendar events',
      expect.objectContaining({ totalEvents: 4, skipped: 1, firstSkipReason: 'missing uid' }),
    )
    // One odd event in a feed isn't an incident — no escalation.
    expect(reportError).not.toHaveBeenCalled()
  })

  it('escalates to Sentry when the skip ratio is anomalous — the "format changed" signal', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 4 of 5 unparseable: this is a format problem, not one bad row.
    const bookings = parseIcalFeed(
      feed([vevent('a'), vevent(null), vevent(null), vevent(null), vevent(null)])
    )

    expect(bookings).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[parseIcalFeed] anomalous share of calendar events unparseable',
      expect.objectContaining({ totalEvents: 5, skipped: 4 }),
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'lib.ical.parser.parseIcalFeed' }),
    )
  })

  it('does not escalate below the floor, even at a high ratio (a 1-of-2 feed is noise)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    parseIcalFeed(feed([vevent('a'), vevent(null)]))

    expect(reportError).not.toHaveBeenCalled()
  })
})
