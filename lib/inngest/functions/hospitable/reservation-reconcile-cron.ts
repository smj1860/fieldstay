// lib/inngest/functions/hospitable/reservation-reconcile-cron.ts
// ============================================================
// Daily cron — dispatches one reservation-reconcile event per active
// Hospitable connection.
//
// THE GAP THIS CLOSES
//
// Hospitable reservations were WEBHOOK-ONLY. hospIncrementalSync fires solely
// from `integration/hospitable.sync.requested`, whose only senders are the
// webhook path in lib/integrations/providers/hospitable.ts. Reservation
// history was pulled exactly once, by hospInitialSync on connect. The two
// existing Hospitable crons don't help: hospCalendarSyncCron syncs calendar
// BLOCKS (Hospitable's /reservations endpoint never represents one) and
// hospTeammateSyncCron syncs crew.
//
// So any reservation created or changed while webhooks were not being
// delivered — a rotated signing secret, a provider outage, deliveries the
// provider eventually stops retrying — never arrived, and nothing ever
// noticed. Found 2026-08-15 after a webhook-secret rotation left a live
// customer's reservations dependent on deliveries that had been rejected for
// hours. That org turned out to have lost nothing, but only because someone
// was watching; there was no mechanism that would have caught it.
//
// This is the same missed-webhook backstop OwnerRez already has as the hourly
// leg of ownerRezIncrementalSync's trigger array, and it uses the same
// dispatch-per-connection shape as ownerRezReconciliationCron /
// hospTeammateSyncCron / hospCalendarSyncCron: this function only FINDS
// connections, and one run per connection does the work under its own
// concurrency cap and retry policy. A rate-limited connection then retries
// alone instead of breaking the whole tick for every other tenant.
//
// Schedule: daily at 10:00 UTC — clear of the 09:00 teammate cron, the 09:30
// calendar cron, OwnerRez's 11:00 reconciliation, and the 13:00/14:00 cluster.
// Daily rather than hourly because the webhook path is primary and healthy;
// this only has to bound how long a missed reservation can stay missing.
//
// ── The shared-budget capacity problem, and why this shards dispatch ───────
//
// hospitableApiLimiter (lib/rate-limit.ts) is ONE shared, platform-wide
// Redis token bucket — 54 requests per 60s — for EVERY Hospitable call this
// app makes, not a per-connection allocation. syncHospitableReservations
// needs 13+ sequential calls per connection (one per lookahead window; see
// hospReservationWindows). Dispatching every active connection's event for
// the SAME instant (what dispatchPerProviderConnection did before this
// change) means the whole platform-wide budget is contended by every
// tenant's reconcile at once, on top of whatever webhook/teammate/calendar
// traffic is already using it — at 100x scale that turns this cron into an
// unbounded, ever-growing backlog: connections queue behind RateLimitError
// retries faster than the shared bucket can drain them, and a run that
// hasn't finished by the next day's 10:00 tick starts overlapping itself
// (the function-level concurrency limit above serializes RUNS OF THIS CRON,
// not the per-connection handlers it fans out to — runProviderReconcile's
// own concurrency caps those separately).
//
// This is a real capacity problem, not a one-line fix — see the two
// follow-ups named below, which THIS change does not attempt. What this
// change DOES do: spread dispatch across HOSPITABLE_RECONCILE_JITTER_WINDOW_
// SECONDS using the same deterministic per-connection `ts` jitter technique
// as hostaway/incremental-sync-cron.ts's jitterSecondsForConnection (hashed
// from the connection's user id, not random — so a replayed Inngest run
// computes the same offset and a connection's own cadence stays predictable
// run to run). Widening the dispatch window from "one instant" to several
// hours meaningfully lowers peak contention on the shared bucket without
// changing anything about how a single connection's reconcile runs.
//
// ── Known follow-up, out of scope for this change ──────────────────────────
//
//   1. A per-day PROCESSED WATERMARK. Today a connection whose reconcile
//      hasn't run yet when the next day's cron fires just gets a second
//      event queued behind the first — nothing tracks "already dispatched
//      today, still in flight" to skip re-dispatching it. At high enough
//      connection counts relative to the shared budget, that is how the
//      cron accumulates backlog rather than merely running long.
//   2. DISPATCH-VS-CAPACITY ALERTING. Nothing today compares "connections
//      dispatched today" against "what the shared budget can plausibly
//      drain in 24h" and pages when dispatch is structurally outrunning
//      capacity — the failure mode this whole finding describes would
//      otherwise grow silently until reconciles are running days late.
//
// Both are real scoped work, not implemented here.
// ============================================================

import { inngest } from '@/lib/inngest/client'
import { dispatchPerProviderConnection } from '../shared/connection-dispatch'

/**
 * The window dispatch is spread across. 20 hours, not the full 24: it leaves
 * a buffer before the NEXT day's 10:00 tick so a connection jittered to the
 * tail end of today's window still has time for runProviderReconcile's own
 * retries to land before it would otherwise queue behind tomorrow's event
 * too. Not tuned against a measured per-connection-count ceiling — see
 * follow-up #2 above — just a meaningfully wider spread than "one instant".
 */
export const HOSPITABLE_RECONCILE_JITTER_WINDOW_SECONDS = 20 * 60 * 60

export const hospReservationReconcileCron = inngest.createFunction(
  {
    id:      'hospitable-reservation-reconcile-cron',
    name:    'Hospitable: Daily Reservation Reconcile Cron',
    retries: 1,
    concurrency: { limit: 1, key: '"hospitable-reservation-reconcile-cron"' },
  },
  { cron: '0 10 * * *' },
  async ({ step, logger }) =>
    dispatchPerProviderConnection({
      step,
      logger,
      provider:            'hospitable',
      system:              'inngest:hospitable-reservation-reconcile-cron',
      label:               'hospitable-reservation-reconcile-cron.connections',
      dispatchStepId:      'dispatch-reconcile-events',
      eventName:           'integration/hospitable.reservation_reconcile.requested',
      logPrefix:           '[Hospitable reconcile cron]',
      jitterWindowSeconds: HOSPITABLE_RECONCILE_JITTER_WINDOW_SECONDS,
    })
)
