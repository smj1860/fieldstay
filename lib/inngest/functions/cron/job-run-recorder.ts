// lib/inngest/functions/cron/job-run-recorder.ts
// ============================================================
// Records every Inngest function run into public.system_job_runs.
//
// WHY THIS EXISTS
//
// system_job_runs was created with a full run-ledger shape — function_id,
// run_id, status, started_at, finished_at, duration_ms, error_message — and
// then never wired to anything. As of 2026-08-15 it held ZERO rows and had no
// writer anywhere in the codebase. A job ledger nobody populates is not
// monitoring; it is the appearance of monitoring.
//
// That mattered twice in one week. The geocoding backfill had never run
// because nothing sent its trigger event, and a rotated Hospitable webhook
// secret left a live customer's reservations undelivered for hours. Both were
// found by a person happening to look. Sentry catches errors; nothing caught
// ABSENCE, because absence produces no error to catch.
//
// HOW IT RECORDS WITHOUT TOUCHING ~37 CRONS
//
// `inngest/function.finished` is emitted by Inngest itself for every run that
// reaches a terminal state. Inngest's own middleware docs point at it as the
// once-per-run guarantee that the `finished` middleware hook explicitly does
// NOT give ("not guaranteed to be called on every execution, and may be called
// multiple times ... for a guaranteed single execution, create a function with
// an event trigger of inngest/function.finished").
//
// So this is one function subscribing to one event. No middleware, no write on
// every step of every function, and not a single line changed in any existing
// cron — which is what makes it safe to add to a live system.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { runIdStartedAt, runDurationMs } from '@/lib/inngest/run-id'

/**
 * Loop breaker.
 *
 * This function is itself an Inngest function, so its own completion emits
 * another `inngest/function.finished` — which would trigger it again, forever.
 * The guard is the whole reason this cannot be a naive subscriber.
 */
const SELF_ID = 'job-run-recorder'

export const jobRunRecorder = inngest.createFunction(
  {
    id:      SELF_ID,
    name:    'System: Record Job Run',
    // One retry. A lost heartbeat row is a monitoring gap, not a data loss,
    // and retrying hard against a struggling database to record that something
    // else struggled is the wrong trade.
    retries: 1,
    // Every function run in the platform passes through here, so this is the
    // one place a burst genuinely needs a ceiling.
    concurrency: { limit: 10 },
  },
  { event: 'inngest/function.finished' as const },
  async ({ event, step, logger }) => {
    const data = event.data ?? {}
    const functionId = String(data.function_id ?? '')

    // Inngest reports the fully-qualified id (`fieldstay-<id>`); the registry
    // in watchdog.ts is written in terms of the bare ids the functions declare,
    // so normalize once here rather than at every read site.
    const bareId = functionId.replace(/^fieldstay-/, '')

    if (bareId === SELF_ID || functionId === SELF_ID) {
      // Recording our own completion would emit another finished event and
      // recurse without bound.
      return { skipped: true, reason: 'self' }
    }

    if (!functionId) {
      logger.warn('[job-run-recorder] finished event with no function_id')
      return { skipped: true, reason: 'no_function_id' }
    }

    await step.run('record-run', async () => {
      const supabase = createServiceClient({ system: 'inngest:job-run-recorder' })

      const error = data.error as { message?: string; stack?: string } | undefined
      const runId = String(data.run_id ?? '')

      // TIMESTAMPS, from the only two sources that actually carry them.
      //
      // `inngest/function.finished` has no timestamp fields at all (see
      // FinishedEventPayload: function_id, run_id, correlation_id, and either
      // error or result). This used to stamp BOTH started_at and finished_at
      // with `new Date()` — the moment the RECORDER ran — so every row had
      // started_at === finished_at, duration_ms was never written, and the
      // ledger could say a job ran but never how long it took. A watchdog
      // cannot flag a job that has gone slow if nothing records slowness.
      //
      //   started_at  — decoded from the run id, which is a ULID whose first
      //                 10 chars are a millisecond timestamp. Verified against
      //                 production: hourly crons decode to exactly :00:00.000.
      //   finished_at — the finished event's own `ts`, i.e. when Inngest
      //                 emitted it. Falls back to now() when absent, which is
      //                 close enough (this handler runs seconds later) and is
      //                 what the column held before regardless.
      const finishedAt = new Date(typeof event.ts === 'number' ? event.ts : Date.now())
      const startedAt  = runIdStartedAt(runId, finishedAt.getTime())
      const durationMs = runDurationMs(startedAt, finishedAt)

      const { error: insertError } = await supabase
        .from('system_job_runs')
        .upsert(
          {
            function_id:   bareId,
            function_name: bareId,
            run_id:        runId,
            // 'succeeded', NOT 'completed'. system_job_runs_status_check
            // allows exactly ('started','succeeded','failed'), and the wrong
            // literal is rejected per-row with 23514 — which this function
            // logs rather than throws, so it failed SILENTLY in production
            // for 47 minutes and left the ledger empty while the recorder
            // looked healthy. A mocked Supabase cannot enforce a CHECK
            // constraint, so the unit test passed on 'completed' too.
            status:        error ? 'failed' : 'succeeded',
            attempt:       0,
            // startedAt is null for a run id that is not a decodable ULID.
            // Falling back to finishedAt keeps the NOT NULL column satisfied
            // and makes the degenerate case look exactly like the old
            // behaviour (zero-length run) rather than inventing a duration.
            started_at:    (startedAt ?? finishedAt).toISOString(),
            finished_at:   finishedAt.toISOString(),
            duration_ms:   durationMs,
            // Truncated: this column is read by a human triaging an outage,
            // and a full stack per row would make the table the outage.
            error_message: error?.message ? String(error.message).slice(0, 1000) : null,
            metadata:      {},
          },
          // Inngest may deliver the same finished event more than once. The
          // table's unique index is on (run_id, function_id) — NOT run_id
          // alone — so the conflict target must name both columns or Postgres
          // rejects the whole statement with 42P10.
          { onConflict: 'run_id,function_id', ignoreDuplicates: true },
        )

      if (insertError) {
        // Logged, never thrown. This function exists to observe the platform;
        // it must not become a source of failures in it.
        logger.error(`[job-run-recorder] insert failed: ${insertError.message}`)
      }
    })

    return { recorded: bareId }
  }
)
