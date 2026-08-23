import { describe, expect, it } from 'vitest'

import { resolveStartTime } from '@/lib/inspections/start-time'

// ============================================================================
// A DEVICE CLOCK, MADE TRUSTWORTHY ENOUGH.
//
// §8 originally required started_at to be a server clock, which made starting
// an inspection the one online-only step in an otherwise offline feature.
// 20260823053931 revises that on a specific argument: the device reports its
// start time AND its own "now", both read at the same instant, so the server
// can measure the skew and subtract it out.
//
// What that buys is a correct start time from a wrong clock. What it does not
// buy is protection against a clock CHANGED mid-walk — and the clamp below is
// what stops that producing a start time in the future.
// ============================================================================

const iso = (ms: number) => new Date(ms).toISOString()

const SERVER_NOW = Date.parse('2026-08-23T12:00:00.000Z')
const MINUTE = 60_000
const HOUR   = 60 * MINUTE

describe('resolveStartTime', () => {
  it('a correct clock is left alone', () => {
    const { startedAt, offsetSeconds } = resolveStartTime(
      iso(SERVER_NOW - 90 * MINUTE), iso(SERVER_NOW), SERVER_NOW,
    )
    expect(offsetSeconds).toBe(0)
    expect(startedAt).toBe(iso(SERVER_NOW - 90 * MINUTE))
  })

  it('a device running FOUR HOURS SLOW still yields the right start', () => {
    // The whole point. The tablet thinks it is 08:00 when the server says
    // 12:00, and believes the walk began 90 minutes ago at 06:30. The real
    // start was 10:30, and the offset is what recovers it.
    const deviceNow     = SERVER_NOW - 4 * HOUR
    const deviceStarted = deviceNow - 90 * MINUTE

    const { startedAt, offsetSeconds } = resolveStartTime(
      iso(deviceStarted), iso(deviceNow), SERVER_NOW,
    )
    expect(offsetSeconds).toBe(4 * 60 * 60)
    expect(startedAt).toBe(iso(SERVER_NOW - 90 * MINUTE))
  })

  it('a device running FAST is corrected the other way', () => {
    const deviceNow     = SERVER_NOW + 3 * HOUR
    const deviceStarted = deviceNow - 30 * MINUTE

    const { startedAt, offsetSeconds } = resolveStartTime(
      iso(deviceStarted), iso(deviceNow), SERVER_NOW,
    )
    expect(offsetSeconds).toBe(-3 * 60 * 60)
    expect(startedAt).toBe(iso(SERVER_NOW - 30 * MINUTE))
  })

  it('the correction measures SKEW, not the offline gap', () => {
    // A walk started six hours ago on a correct clock, synced now: the offset
    // is zero and the start time is six hours ago. Confusing the gap for skew
    // would report the inspection as starting the instant it synced, which is
    // exactly the duration claim the 24-hour rule reads.
    const { startedAt, offsetSeconds } = resolveStartTime(
      iso(SERVER_NOW - 6 * HOUR), iso(SERVER_NOW), SERVER_NOW,
    )
    expect(offsetSeconds).toBe(0)
    expect(startedAt).toBe(iso(SERVER_NOW - 6 * HOUR))
  })

  it('CLAMPS a corrected start that lands in the future', () => {
    // Only reachable when the device's two readings disagree with each other —
    // the clock was changed between starting the walk and syncing. An
    // inspection that began after the present is nonsense, and letting it
    // through would make the duration negative.
    const deviceNow     = SERVER_NOW
    const deviceStarted = SERVER_NOW + 2 * HOUR

    const { startedAt } = resolveStartTime(iso(deviceStarted), iso(deviceNow), SERVER_NOW)
    expect(startedAt).toBe(iso(SERVER_NOW))
  })

  it('rounds the offset to whole seconds', () => {
    // It is stored in an integer column. A float would be silently truncated
    // by Postgres rather than rejected.
    const { offsetSeconds } = resolveStartTime(
      iso(SERVER_NOW - MINUTE), iso(SERVER_NOW - 1400), SERVER_NOW,
    )
    expect(Number.isInteger(offsetSeconds)).toBe(true)
    expect(offsetSeconds).toBe(1)
  })

  it('a walk that started this instant is not pushed into the future', () => {
    const { startedAt } = resolveStartTime(iso(SERVER_NOW), iso(SERVER_NOW), SERVER_NOW)
    expect(Date.parse(startedAt)).toBeLessThanOrEqual(SERVER_NOW)
  })
})
