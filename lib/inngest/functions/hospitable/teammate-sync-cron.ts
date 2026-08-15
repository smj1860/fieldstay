// lib/inngest/functions/hospitable/teammate-sync-cron.ts
// ============================================================
// Daily cron — dispatches one teammate resync event per active Hospitable
// connection. Hospitable has no teammate.* webhook (confirmed against the
// partner API docs), so initial-sync.ts's one-time teammate fetch is the
// only sync that would otherwise ever happen — a crew member added,
// reassigned, or removed in Hospitable after connecting would never be
// reflected in FieldStay. This closes that gap with a lightweight full
// resync once a day, same dispatch-per-connection pattern as
// integrationTokenRefreshCron so one org's failure never blocks another's.
//
// Schedule: daily at 09:00 UTC — clear of the 13:00/14:00 UTC cron cluster
// (maintenance-schedules, work-order-ops, asset-health, comms-retention,
// turnover-priority-decay all run then).
// ============================================================

import { inngest } from '@/lib/inngest/client'
import { dispatchPerHospitableConnection } from './connection-dispatch'

export const hospTeammateSyncCron = inngest.createFunction(
  {
    id:      'hospitable-teammate-sync-cron',
    name:    'Hospitable: Daily Teammate Resync Cron',
    retries: 1,
    // Prevent overlapping runs if manually triggered while a scheduled run is active
    concurrency: { limit: 1, key: '"hospitable-teammate-sync-cron"' },
  },
  { cron: '0 9 * * *' },
  // Body extracted to connection-dispatch.ts on 2026-08-15 — this and
  // hospReservationReconcileCron were the same ~40 lines with four strings
  // changed. Step ids ('fetch-active-connections', 'dispatch-teammate-sync-
  // events') are unchanged, so a run in flight across the deploy resumes.
  async ({ step, logger }) =>
    dispatchPerHospitableConnection({
      step,
      logger,
      system:         'inngest:teammate-sync-cron',
      label:          'hospitable-teammate-sync-cron.connections',
      dispatchStepId: 'dispatch-teammate-sync-events',
      eventName:      'integration/hospitable.teammate_sync.requested',
      logPrefix:      '[Hospitable teammate-sync cron]',
    })
)
