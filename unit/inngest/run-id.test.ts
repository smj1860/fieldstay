import { describe, it, expect } from 'vitest'
import { runIdStartedAt, runDurationMs } from '@/lib/inngest/run-id'

// ============================================================================
// Decoding a run's START time out of its Inngest run id.
//
// This exists because `inngest/function.finished` carries NO timestamps —
// function_id, run_id, correlation_id and either error or result, and that is
// all. job-run-recorder stamped both started_at and finished_at with
// `new Date()` (when the RECORDER ran) and never wrote duration_ms, so every
// row in system_job_runs had a zero-length run. A watchdog cannot flag a job
// that has gone slow if nothing records slowness.
//
// The fixtures below are REAL production run ids, taken from
// integration-token-refresh-cron on 2026-08-18. That cron is `0 * * * *`, so a
// correct decoder must land on exactly :00:00.000 — which is a much sharper
// assertion than "some plausible date" and is what confirms the bit-level
// decode rather than merely the shape.
// ============================================================================

describe('runIdStartedAt', () => {
  it.each([
    ['01M0AJQZR0SJSAVVPKZ5HSBFY8', '2026-08-18T14:00:00.000Z'],
    ['01M0AFA440KSW19RQQ1H527SC4', '2026-08-18T13:00:00.000Z'],
    ['01M0ABW8G01Y7785GD6WA541B3', '2026-08-18T12:00:00.000Z'],
    ['01M0A8ECW0405G6AN6BQ3ZP6MA', '2026-08-18T11:00:00.000Z'],
    ['01M0A50H80QEE9ZR65Z4HDVK0C', '2026-08-18T10:00:00.000Z'],
  ])('decodes %s to the exact hour boundary', (runId, expected) => {
    const at = runIdStartedAt(runId, Date.parse('2026-08-18T15:00:00.000Z'))
    expect(at?.toISOString()).toBe(expected)
  })

  it('returns null for an id that is not Crockford base32', () => {
    // I, L, O and U are excluded from the alphabet precisely because they read
    // as 1/0 — an id containing them is not a ULID and must not decode to a
    // confidently wrong timestamp.
    expect(runIdStartedAt('01M0AJQZI0SJSAVVPKZ5HSBFY8')).toBeNull()
    expect(runIdStartedAt('not-a-ulid-at-all')).toBeNull()
  })

  it('returns null for a short or empty id', () => {
    expect(runIdStartedAt('')).toBeNull()
    expect(runIdStartedAt('01M0AJ')).toBeNull()
    expect(runIdStartedAt(undefined as unknown as string)).toBeNull()
  })

  it('rejects an implausibly OLD decode rather than trusting it', () => {
    // THE FAILURE THIS PREVENTS. A garbage id decoding to 1970 against a
    // finish time of now yields a "duration" of five decades — which overflows
    // duration_ms (int4 caps near 24.8 days) and rejects the whole INSERT with
    // 22003. One bad id would then stop the row being recorded at all, in a
    // table whose entire job is noticing absence.
    expect(runIdStartedAt('0000000000AAAAAAAAAAAAAAAA')).toBeNull()
  })

  it('rejects a decode more than a day in the future', () => {
    const now = Date.parse('2026-08-18T15:00:00.000Z')
    // 01M0AJQZR0 is 14:00 on the 18th — fine relative to a 15:00 "now"...
    expect(runIdStartedAt('01M0AJQZR0SJSAVVPKZ5HSBFY8', now)).not.toBeNull()
    // ...and not fine relative to a "now" three days earlier.
    expect(runIdStartedAt('01M0AJQZR0SJSAVVPKZ5HSBFY8', now - 3 * 86_400_000)).toBeNull()
  })

  it('accepts lowercase', () => {
    expect(runIdStartedAt('01m0ajqzr0sjsavvpkz5hsbfy8', Date.parse('2026-08-18T15:00:00Z'))
      ?.toISOString()).toBe('2026-08-18T14:00:00.000Z')
  })
})

describe('runDurationMs', () => {
  it('is the gap between the decoded start and the finished event', () => {
    const started  = new Date('2026-08-18T14:00:00.000Z')
    const finished = new Date('2026-08-18T14:00:09.203Z')
    expect(runDurationMs(started, finished)).toBe(9203)
  })

  it('is null when the start could not be decoded', () => {
    // A missing duration is a smaller loss than a wrong one.
    expect(runDurationMs(null, new Date())).toBeNull()
  })

  it('clamps a negative gap to zero rather than recording it', () => {
    // started_at comes from the run id and finished_at from the event's own
    // `ts` — stamped by different parts of Inngest, so a few milliseconds of
    // disagreement on a very fast run is normal and is not a negative runtime.
    const started  = new Date('2026-08-18T14:00:00.050Z')
    const finished = new Date('2026-08-18T14:00:00.000Z')
    expect(runDurationMs(started, finished)).toBe(0)
  })
})
