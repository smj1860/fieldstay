// lib/inngest/functions/hostaway/sync-lock.ts
//
// The cross-function lock key shared by the incremental sweep and the daily
// reconcile — two DISTINCT Inngest functions, so Inngest's own
// `concurrency: [{ limit: 1, key: 'event.data.org_id' }]` on each does not
// stop them from running at once for the same org: that key only serializes
// a function against ITSELF. hostawayIncrementalSyncCron jitters individual
// dispatches up to 55 minutes into the next hour while
// hostawayReservationReconcileCron fires un-jittered at 07:30 UTC, so the
// two genuinely overlap for every Hostaway org during the 07:00 hour, both
// racing generateTurnoversForProperty with no org-level guard.
//
// A shared function (not a duplicated string literal in each handler) is
// what keeps the two locks pointed at the SAME key — a typo'd suffix in
// either file would silently defeat the whole guard.
export function hostawaySyncLockKey(orgId: string): string {
  return `hostaway:sync-lock:${orgId}`
}
