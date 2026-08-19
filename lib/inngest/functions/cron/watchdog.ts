// lib/inngest/functions/cron/watchdog.ts
// ============================================================
// Hourly watchdog. Detects ABSENCE — the failure mode nothing else here can
// see.
//
// Sentry catches errors. Every guardrail in unit/guardrails/ reads code. The
// db-invariants job inspects schema. None of them can notice that something
// simply STOPPED: a cron that no longer fires, an integration whose webhooks
// are being rejected, a scheduled job silently unscheduled. Absence throws no
// exception, so it reaches no error tracker.
//
// Two live incidents inside one week, both found only because a person happened
// to look:
//
//   - A geocoding backfill that had never run at all, because nothing ever
//     sent the event that was its only trigger.
//   - A rotated Hospitable webhook secret that left a real customer's
//     reservation deliveries rejected for hours.
//
// This is the thing that would have said so.
//
// WHY IT ALERTS THROUGH reportError()
//
// These are PLATFORM faults, not tenant faults, so the per-org notification
// bell is the wrong channel — the affected org usually cannot act on it, and
// the operator is the one who can. reportError() already routes to Sentry,
// which already has alerting attached. Building a second alert channel for a
// watchdog would mean the watchdog depends on infrastructure nobody is
// watching either.
//
// Deliberately conservative thresholds. A watchdog that cries wolf gets muted,
// and a muted watchdog is worse than none — it converts an open question into
// a false sense of coverage. Every threshold below is at least twice the
// job's period, so a single missed run is tolerated and a stopped job is not.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'

const HOUR_MS = 3_600_000

/**
 * The jobs whose silence is worth waking someone for, with how long a gap is
 * genuinely abnormal.
 *
 * Schedules are the ones the functions actually declare — read from source,
 * not assumed — and each budget is roughly 2x the period so one missed or
 * slow run does not page anyone:
 *
 *   ownerrez-incremental-sync          0 * * * *      hourly
 *   integration-token-refresh-cron     0 * * * *      hourly
 *   cron-metrics-snapshot              slash-30       every 30 min
 *   hospitable-teammate-sync-cron      0 9 * * *      daily
 *   hospitable-calendar-sync-cron      30 9 * * *     daily
 *   hospitable-reservation-reconcile   0 10 * * *     daily
 *   ownerrez-reconciliation-cron       0 11 * * *     daily
 *   cron-asset-health                  30 12 * * *    daily
 *   cron-maintenance-schedule-check    0 13 * * *     daily
 *   cron-daily-wrapup                  0 23 * * *     daily
 *
 * NOT the full set of 37 crons, on purpose. This list is the ones whose
 * silence has a customer-visible consequence; padding it with every retention
 * sweep would add noise without adding signal.
 */
export const WATCHED_JOBS: { id: string; maxSilentHours: number }[] = [
  { id: 'ownerrez-incremental-sync',                maxSilentHours: 3 },
  { id: 'integration-token-refresh-cron',           maxSilentHours: 3 },
  { id: 'cron-metrics-snapshot',                    maxSilentHours: 3 },
  { id: 'hospitable-teammate-sync-cron',            maxSilentHours: 30 },
  { id: 'hospitable-calendar-sync-cron',            maxSilentHours: 30 },
  { id: 'hospitable-reservation-reconcile-cron',    maxSilentHours: 30 },
  { id: 'ownerrez-reconciliation-cron',             maxSilentHours: 30 },
  { id: 'cron-asset-health',                        maxSilentHours: 30 },
  { id: 'cron-maintenance-schedule-check',          maxSilentHours: 30 },
  { id: 'cron-daily-wrapup',                        maxSilentHours: 30 },
]

/**
 * How long an ACTIVE integration may show no activity before it is treated as
 * quiet.
 *
 * 48h, because every provider here is touched by at least one daily cron: a
 * healthy connection stamps last_used_at every day. Two full days of nothing
 * on a connection the PM believes is live is the shape of the 2026-08-15
 * webhook-secret incident.
 */
const INTEGRATION_QUIET_HOURS = 48

/**
 * Grace period after connecting before quietness counts.
 *
 * A connection made an hour ago has legitimately not been touched by a daily
 * cron yet, and alerting on it would fire on every new customer — the fastest
 * way to teach an operator to ignore this alert.
 */
const NEW_CONNECTION_GRACE_HOURS = 50

interface JobRunRow  {
  function_id: string
  started_at:  string
  /** null for runs recorded before the recorder learned to compute it. */
  duration_ms: number | null
  /** ULID. Its first 10 characters are the creation millisecond — see run-id.ts. */
  run_id:      string
}
interface ConnRow    {
  id: string
  provider_id: string
  org_id: string | null
  connected_at: string | null
  last_used_at: string | null
  updated_at: string | null
}

/** A watched job that is past its silence budget. */
interface SilentJob {
  id: string
  maxSilentHours: number
  /** null when the job has never been recorded at all, vs. recorded then stopped. */
  silentForHours: number | null
}

/** A watched job whose most recent run took far longer than its own norm. */
interface SlowJob {
  id: string
  latestMs: number
  medianMs: number
}

/** A cron whose single scheduler tick is being executed more than once. */
interface DuplicatedCron {
  id: string
  /** Distinct scheduler ticks seen in the window. */
  ticks: number
  /** Total runs across those ticks. */
  runs: number
  /** Worst observed executions of ONE tick — i.e. how many syncs it reached. */
  worstFanout: number
}

/**
 * Slow-run detection is RELATIVE TO EACH JOB'S OWN NORM, not an absolute
 * duration ceiling.
 *
 * An absolute ceiling is the obvious design and it is wrong here: an Inngest
 * run's wall-clock includes any `step.sleep`, and several functions sleep
 * deliberately — withProviderCall sleeps for a provider's Retry-After, the
 * reviews backfill sleeps between rate-limited pages. A "longer than 10
 * minutes is slow" rule would fire on those every time they did exactly what
 * they were designed to do, and an alarm that fires on correct behaviour is
 * one an operator learns to close unread.
 *
 * A job's median over the window is a baseline that already accounts for its
 * own sleeps, so the comparison catches what actually matters: a step CHANGE.
 * The job that ran in 4 seconds all week and now takes six minutes.
 *
 * ⚠️ KNOWN BLIND SPOT, stated rather than papered over: this cannot see
 * GRADUAL drift, because the baseline drifts with it. A job creeping from 10s
 * to 5 minutes over a month never trips a multiple of its own recent median.
 * Catching that needs history longer than this watchdog's 31-hour window and
 * is a different tool; duration_ms is now recorded, so the data for it exists.
 */
const SLOW_FLOOR_MS      = 60_000
const SLOW_MULTIPLE      = 3
const SLOW_MIN_SAMPLES   = 5

/** Median of a non-empty numeric list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

/**
 * Watched jobs whose latest run is an outlier against their own median.
 *
 * Requires SLOW_MIN_SAMPLES runs before judging anything: a median of two
 * samples is not a norm, and a daily cron simply will not have enough history
 * in a 31-hour window — which is correct, not a gap. Those are the jobs whose
 * silence the watchdog already covers.
 */
function findSlowJobs(rows: JobRunRow[], watched: readonly string[]): SlowJob[] {
  const byFunction = new Map<string, { at: number; ms: number }[]>()

  for (const row of rows) {
    if (row.duration_ms === null || row.duration_ms === undefined) continue
    const at = Date.parse(row.started_at)
    if (Number.isNaN(at)) continue
    const list = byFunction.get(row.function_id) ?? []
    list.push({ at, ms: row.duration_ms })
    byFunction.set(row.function_id, list)
  }

  return watched.flatMap<SlowJob>((id) => {
    const runs = byFunction.get(id)
    if (!runs || runs.length < SLOW_MIN_SAMPLES) return []

    // An explicit scan rather than reduce(). A no-initial-value reduce throws
    // TypeError on an empty array, and while the length guard above makes that
    // unreachable TODAY, the guard is three lines away and someone relaxing
    // SLOW_MIN_SAMPLES to 0 would turn the watchdog itself into the thing that
    // crashes — which is the one function that must not. Seeding the reduce
    // with runs[0] would satisfy the linter while still reading as if the empty
    // case were handled; this cannot be misread.
    let latest = runs[0]!
    for (const run of runs) {
      if (run.at > latest.at) latest = run
    }
    const baseline = median(runs.map((r) => r.ms))
    const threshold = Math.max(SLOW_FLOOR_MS, baseline * SLOW_MULTIPLE)

    if (latest.ms < threshold) return []
    return [{ id, latestMs: latest.ms, medianMs: Math.round(baseline) }]
  })
}

/**
 * How many ticks must show duplication before it is reported.
 *
 * Two, not one. A single duplicated tick is the shape of a one-off — a deploy
 * landing mid-tick, a sync being registered at that moment — and reporting it
 * would make this alarm flap during every deployment. A SECOND duplicated tick
 * means a duplicate registration is sitting there persistently, which is the
 * only version of this worth waking anyone for.
 */
const DUPLICATE_MIN_TICKS = 2

/** ULID timestamp length — the run's creation millisecond. See run-id.ts. */
const TICK_PREFIX_LEN = 10

/**
 * Crons whose ONE scheduler tick is being executed more than once.
 *
 * ── What this catches, and why nothing else did ─────────────────────────────
 *
 * An Inngest app can carry several SYNCS — one per deployment URL that has
 * registered itself. Every sync receives every scheduler tick, so a stale
 * preview deployment that nobody deleted keeps executing the full cron suite
 * forever. On 2026-08-18 every cron here was running SIX times an hour that
 * way, and the whole system read as healthy: each duplicate run succeeded, so
 * CI was green, Sentry was quiet, the silence check was satisfied by definition
 * (the job was anything but silent), and the run ledger showed nothing but
 * successes. It was only visible by noticing that six runs shared one ULID
 * millisecond prefix.
 *
 * That prefix is the whole trick. A ULID's first 10 characters are its creation
 * millisecond, so runs of the SAME function created in the SAME millisecond are
 * one scheduler tick fanned across N syncs — they cannot be N genuine ticks,
 * because no cron schedule has millisecond granularity.
 *
 * ── Why only WATCHED_JOBS ───────────────────────────────────────────────────
 *
 * Every entry in WATCHED_JOBS is cron-triggered, and that is exactly the set
 * for which one tick must mean one run. Event-driven fan-out handlers legitimately
 * produce many same-millisecond runs — `daily-wrapup-org` fires once per org and
 * `ownerrez-connection-sync` once per connection, both dispatched in a single
 * `step.sendEvent`. Scanning those would report the system's normal behaviour
 * as a fault, every hour.
 *
 * Distinct run_ids are counted rather than rows, so a retry — which keeps its
 * run_id, and which the (run_id, function_id) unique index deduplicates anyway
 * — can never be mistaken for a duplicate execution.
 */
function findDuplicatedCrons(rows: JobRunRow[], watched: readonly string[]): DuplicatedCron[] {
  // function_id -> tick prefix -> distinct run ids in that tick
  const byFunction = new Map<string, Map<string, Set<string>>>()

  for (const row of rows) {
    if (typeof row.run_id !== 'string' || row.run_id.length < TICK_PREFIX_LEN) continue
    const tick = row.run_id.slice(0, TICK_PREFIX_LEN)

    const ticks = byFunction.get(row.function_id) ?? new Map<string, Set<string>>()
    const runs  = ticks.get(tick) ?? new Set<string>()
    runs.add(row.run_id)
    ticks.set(tick, runs)
    byFunction.set(row.function_id, ticks)
  }

  return watched.flatMap<DuplicatedCron>((id) => {
    const ticks = byFunction.get(id)
    if (!ticks) return []

    let duplicatedTicks = 0
    let worstFanout     = 0
    let totalRuns       = 0

    for (const runs of ticks.values()) {
      totalRuns += runs.size
      if (runs.size > 1) {
        duplicatedTicks += 1
        if (runs.size > worstFanout) worstFanout = runs.size
      }
    }

    if (duplicatedTicks < DUPLICATE_MIN_TICKS) return []
    return { id, ticks: ticks.size, runs: totalRuns, worstFanout }
  })
}

/** Most recent recorded run per watched job. */
function latestByFunction(rows: JobRunRow[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const row of rows) {
    const at = Date.parse(row.started_at)
    if (Number.isNaN(at)) continue
    const seen = latest.get(row.function_id)
    if (seen === undefined || at > seen) latest.set(row.function_id, at)
  }
  return latest
}

export const systemWatchdog = inngest.createFunction(
  {
    id:      'system-watchdog',
    name:    'System: Watchdog (silent jobs and quiet integrations)',
    retries: 2,
    concurrency: { limit: 1, key: '"system-watchdog"' },
  },
  { cron: '15 * * * *' },
  async ({ step, logger }) => {
    const now = Date.now()

    // ── 1. Jobs that have gone silent ───────────────────────────────────────
    const silentAndSlow = await step.run('check-silent-jobs', async () => {
      const supabase = createServiceClient({ system: 'inngest:system-watchdog' })

      // Bounded by the widest budget in the registry, so this reads a day and a
      // bit of history rather than the whole table as it grows.
      const since = new Date(now - 31 * HOUR_MS).toISOString()

      const rows = await fetchAllRows<JobRunRow>(
        (from, to) => supabase
          .from('system_job_runs')
          .select('function_id, started_at, duration_ms, run_id')
          .gte('started_at', since)
          .order('started_at', { ascending: false })
          .range(from, to),
        { label: 'watchdog.job-runs' },
      )

      const latest = latestByFunction(rows)

      // COLD START.
      //
      // "No run recorded" and "never ran" are the same observation, and on the
      // first deploy they are indistinguishable — the table is empty because
      // recording just began, not because ten crons are broken. Without this,
      // the first run reports every watched job as silent, and the seven daily
      // ones keep reporting hourly until each fires, up to a day later. That
      // is ~24h of alerts naming healthy crons, which is exactly how an
      // operator learns to ignore this channel.
      //
      // The oldest row is the proxy for when recording started, so a job with
      // NO recorded run is only reported once recording has been live longer
      // than that job's own budget. A job that recorded and then STOPPED is
      // unaffected — that path never consults this.
      //
      // Read separately because the window above is capped at 31h and this
      // needs the true oldest row.
      const oldest = await supabase
        .from('system_job_runs')
        .select('started_at')
        .order('started_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      const recordingSince = oldest.data?.started_at ? Date.parse(oldest.data.started_at) : null
      const recordingAgeMs = recordingSince === null ? 0 : now - recordingSince

      const silentJobs = WATCHED_JOBS.flatMap<SilentJob>(({ id, maxSilentHours }) => {
        const last = latest.get(id)

        if (last === undefined) {
          // Not yet observable: recording has not been running long enough for
          // this job's absence to mean anything.
          if (recordingAgeMs <= maxSilentHours * HOUR_MS) return []
          return [{ id, maxSilentHours, silentForHours: null }]
        }

        if (now - last <= maxSilentHours * HOUR_MS) return []
        return [{ id, maxSilentHours, silentForHours: Math.round((now - last) / HOUR_MS) }]
      })

      // Same rows, no second query: silence and slowness are two readings of
      // one scan.
      const watchedIds = WATCHED_JOBS.map((j) => j.id)
      const slowJobs   = findSlowJobs(rows, watchedIds)
      // Third reading of the same scan. Duplication is invisible to the other
      // two by construction: a duplicated job is not silent, and each of its
      // runs is individually a normal duration.
      const duplicatedCrons = findDuplicatedCrons(rows, watchedIds)

      return { silentJobs, slowJobs, duplicatedCrons }
    })

    const silent     = silentAndSlow.silentJobs
    const slow       = silentAndSlow.slowJobs
    const duplicated = silentAndSlow.duplicatedCrons

    // An entirely empty ledger is its own finding, not ten of them. It is
    // expected exactly once — on the very first run, before this watchdog's own
    // completion has been recorded — and after that it means the recorder is
    // not working, which is worth knowing precisely because every other check
    // here depends on it.
    const noRunsRecorded = await step.run('check-recording-alive', async () => {
      const supabase = createServiceClient({ system: 'inngest:system-watchdog' })
      const { count } = await supabase
        .from('system_job_runs')
        .select('*', { count: 'exact', head: true })
      return (count ?? 0) === 0
    })

    // ── 2. Active integrations that have gone quiet ─────────────────────────
    const quiet = await step.run('check-quiet-integrations', async () => {
      const supabase = createServiceClient({ system: 'inngest:system-watchdog' })

      // PLATFORM-WIDE — every live connection, not one tenant's. Paginated for
      // the usual max_rows reason: truncation here would mean the connections
      // past row 1000 are the ones never checked, silently.
      const rows = await fetchAllRows<ConnRow>(
        (from, to) => supabase
          .from('integration_connections')
          .select('id, provider_id, org_id, connected_at, last_used_at, updated_at')
          .eq('status', 'active')
          .order('id')
          .range(from, to),
        { label: 'watchdog.connections' },
      )

      const graceCutoff = now - NEW_CONNECTION_GRACE_HOURS * HOUR_MS
      const quietCutoff = now - INTEGRATION_QUIET_HOURS * HOUR_MS

      return rows.flatMap((c) => {
        const connectedAt = c.connected_at ? Date.parse(c.connected_at) : 0
        // Too new to have been touched by a daily cron yet.
        if (connectedAt > graceCutoff) return []

        const stamps = [c.last_used_at, c.updated_at, c.connected_at]
          .map((s) => (s ? Date.parse(s) : Number.NaN))
          .filter((n) => !Number.isNaN(n))

        const lastActivity = stamps.length ? Math.max(...stamps) : 0
        if (lastActivity > quietCutoff) return []

        return [{
          connection_id: c.id,
          provider:      c.provider_id,
          org_id:        c.org_id,
          quiet_hours:   Math.round((now - lastActivity) / HOUR_MS),
        }]
      })
    })

    // ── 3. Report ───────────────────────────────────────────────────────────
    // reportError rather than throw: throwing would retry the watchdog, and a
    // watchdog that retries because it FOUND something would re-report the
    // same finding on every attempt.
    if (silent.length > 0) {
      const summary = silent
        .map((s) => {
          const age = s.silentForHours === null ? 'since before the window' : `${s.silentForHours}h`
          return `${s.id} (silent ${age}, budget ${s.maxSilentHours}h)`
        })
        .join('; ')
      logger.error(`[watchdog] ${silent.length} job(s) have gone silent: ${summary}`)
      reportError(new Error(`Watchdog: ${silent.length} scheduled job(s) silent — ${summary}`), {
        site: 'inngest.system-watchdog.silent-jobs',
      })
    }

    if (slow.length > 0) {
      // A WARNING, not an error: a job that is slow is still running, which is
      // a materially different situation from one that has stopped. Reported
      // so a step change is visible before it becomes a timeout or an overlap
      // with the job's own next tick.
      const summary = slow
        .map((j) => `${j.id} (${Math.round(j.latestMs / 1000)}s vs ${Math.round(j.medianMs / 1000)}s median)`)
        .join('; ')
      logger.warn(`[watchdog] ${slow.length} job(s) slower than their norm: ${summary}`)
      reportError(new Error(`Watchdog: ${slow.length} scheduled job(s) slow — ${summary}`), {
        site: 'inngest.system-watchdog.slow-jobs',
      })
    }

    if (duplicated.length > 0) {
      // An ERROR, not a warning. Every duplicate run is a full second execution
      // of the job: doubled provider API spend against shared rate limits,
      // doubled compute, and doubled side effects for anything not perfectly
      // idempotent. It also degrades silently — the runs all succeed, so this
      // is the only place it can surface.
      const summary = duplicated
        .map((d) => `${d.id} (${d.worstFanout}x per tick, ${d.runs} runs over ${d.ticks} ticks)`)
        .join('; ')
      logger.error(`[watchdog] ${duplicated.length} cron(s) running more than once per tick: ${summary}`)
      reportError(
        new Error(
          `Watchdog: ${duplicated.length} cron(s) executing more than once per scheduler tick — ${summary}. ` +
          'Usually a stale Inngest sync: an old deployment URL still registered against the app receives ' +
          'every tick alongside production. Archive the extra sync, or delete the deployment that registered it.'
        ),
        { site: 'inngest.system-watchdog.duplicated-crons' },
      )
    }

    if (quiet.length > 0) {
      // org_id and provider only — never a token, and nothing about the
      // provider account beyond which integration it is.
      const summary = quiet
        .map((q) => `${q.provider} (org ${q.org_id ?? 'unknown'}, quiet ${q.quiet_hours}h)`)
        .join('; ')
      logger.error(`[watchdog] ${quiet.length} active integration(s) quiet: ${summary}`)
      reportError(new Error(`Watchdog: ${quiet.length} active integration(s) quiet — ${summary}`), {
        site: 'inngest.system-watchdog.quiet-integrations',
      })
    }

    if (noRunsRecorded) {
      logger.error('[watchdog] system_job_runs is EMPTY — no job runs are being recorded at all')
      reportError(
        new Error('Watchdog: system_job_runs is empty — jobRunRecorder is not recording runs'),
        { site: 'inngest.system-watchdog.recording-dead' },
      )
    }

    if (silent.length === 0 && quiet.length === 0 && duplicated.length === 0 && !noRunsRecorded) {
      logger.info(`[watchdog] OK — ${WATCHED_JOBS.length} jobs within budget, all active integrations recently seen`)
    }

    return {
      silentJobs:       silent.length,
      slowJobs:         slow.length,
      duplicatedCrons:  duplicated.length,
      quietIntegrations: quiet.length,
      noRunsRecorded,
    }
  }
)
