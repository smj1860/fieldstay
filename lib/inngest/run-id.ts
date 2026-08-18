// lib/inngest/run-id.ts
// ============================================================================
// Reading a run's START time out of its Inngest run id.
//
// WHY THIS IS NEEDED AT ALL
//
// `inngest/function.finished` — the once-per-run event job-run-recorder.ts
// subscribes to — carries function_id, run_id, correlation_id and either
// `error` or `result`. It carries NO TIMESTAMPS. So the recorder stamped both
// started_at and finished_at with `new Date()` (the moment IT processed the
// event) and never wrote duration_ms at all. Every row in system_job_runs has
// started_at === finished_at and a null duration, which means the ledger could
// say a job RAN but never how long it took — and a watchdog cannot flag a job
// that has gone slow if nothing records slowness.
//
// Inngest run ids are ULIDs, and a ULID's first 10 characters are a 48-bit
// millisecond timestamp in Crockford base32. That is the run's creation time,
// available for free from a field already in the payload.
//
// VERIFIED against production rather than assumed: on 2026-08-18 the six runs
// of integration-token-refresh-cron in each hour shared one 10-character
// prefix, and that prefix changed every hour (01M0A50H80 at 10:00,
// 01M0A8ECW0 at 11:00, 01M0ABW8G0 at 12:00, …). Decoding 01M0AJQZR0 gives
// 2026-08-18T14:00 UTC, matching the 14:00 tick. Same-millisecond creation is
// also what proved those six runs were one scheduler tick fanned across six
// stale deployment syncs, rather than six independent schedules.
// ============================================================================

/** Crockford base32 — ULID's alphabet. No I, L, O or U (they read as 1/0). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID timestamps are the first 10 characters. */
const TIMESTAMP_CHARS = 10

/**
 * A decoded timestamp outside this range is treated as garbage rather than
 * trusted.
 *
 * The failure this prevents is specific: a malformed id decodes to some
 * arbitrary epoch, and a start time of 1970 against a finish time of now
 * yields a "duration" of five decades. That overflows `duration_ms` (int4 tops
 * out around 24.8 days) and rejects the whole insert with 22003 — so one bad
 * id would stop the row being recorded at all, in a table whose entire job is
 * noticing absence. It would also make any slow-job alarm fire on every run.
 */
const PLAUSIBLE_FROM_MS = Date.UTC(2020, 0, 1)
const PLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * The run's creation time, decoded from its ULID run id, or null when the id
 * is not a ULID or decodes implausibly.
 *
 * Null rather than a throw or a fallback: the caller records a run either way,
 * and a missing duration is a smaller loss than a wrong one.
 */
export function runIdStartedAt(runId: string, now: number = Date.now()): Date | null {
  if (typeof runId !== 'string' || runId.length < TIMESTAMP_CHARS) return null

  let ms = 0
  for (let i = 0; i < TIMESTAMP_CHARS; i++) {
    const index = CROCKFORD.indexOf(runId[i]!.toUpperCase())
    if (index === -1) return null
    ms = ms * 32 + index
  }

  // Future-dated beyond a day of clock skew is as wrong as ancient.
  if (ms < PLAUSIBLE_FROM_MS || ms > now + PLAUSIBLE_SKEW_MS) return null

  return new Date(ms)
}

/**
 * How long a run took, in whole milliseconds, or null when it cannot be known.
 *
 * Clamped at zero rather than allowed negative: `finished` comes from the
 * finished event's own `ts` and `started` from the run id, which are stamped by
 * different parts of Inngest, so a few milliseconds of disagreement on a very
 * fast run is normal and is not worth recording as a negative duration.
 */
export function runDurationMs(startedAt: Date | null, finishedAt: Date): number | null {
  if (startedAt === null) return null
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}
