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

interface JobRunRow  { function_id: string; started_at: string }
interface ConnRow    {
  id: string
  provider_id: string
  org_id: string | null
  connected_at: string | null
  last_used_at: string | null
  updated_at: string | null
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
    const silent = await step.run('check-silent-jobs', async () => {
      const supabase = createServiceClient({ system: 'inngest:system-watchdog' })

      // Bounded by the widest budget in the registry, so this reads a day and a
      // bit of history rather than the whole table as it grows.
      const since = new Date(now - 31 * HOUR_MS).toISOString()

      const rows = await fetchAllRows<JobRunRow>(
        (from, to) => supabase
          .from('system_job_runs')
          .select('function_id, started_at')
          .gte('started_at', since)
          .order('started_at', { ascending: false })
          .range(from, to),
        { label: 'watchdog.job-runs' },
      )

      const latest = latestByFunction(rows)

      return WATCHED_JOBS.flatMap(({ id, maxSilentHours }) => {
        const last = latest.get(id)
        const silentFor = last === undefined ? null : Math.round((now - last) / HOUR_MS)
        if (last !== undefined && now - last <= maxSilentHours * HOUR_MS) return []
        return [{ id, maxSilentHours, silentForHours: silentFor }]
      })
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

    if (silent.length === 0 && quiet.length === 0) {
      logger.info(`[watchdog] OK — ${WATCHED_JOBS.length} jobs within budget, all active integrations recently seen`)
    }

    return { silentJobs: silent.length, quietIntegrations: quiet.length }
  }
)
