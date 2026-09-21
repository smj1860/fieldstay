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

import { PMS_API_TIMEOUT_MS } from '@/lib/http/timeout'
import { HOSTAWAY_PAGINATION_MAX_PAGES } from '@/lib/integrations/providers/hostaway'

export function hostawaySyncLockKey(orgId: string): string {
  return `hostaway:sync-lock:${orgId}`
}

/**
 * The lock's TTL, sized off the worst-case sequential pagination this lock
 * must outlive rather than a guessed flat number.
 *
 * The previous flat 300s covered roughly 10 pages of one fetch — a real
 * account with a few thousand reservations blows past that on an ordinary
 * day, letting the lock expire mid-run and the sibling function (whichever
 * of the hourly sweep / daily reconcile is NOT currently holding it) acquire
 * it: the exact TOCTOU on generateTurnoversForProperty this lock exists to
 * prevent — see the header above.
 *
 * The reconcile handler is the worst case: it runs syncHostawayReservations
 * AND syncHostawayReviews back-to-back in one locked run (see
 * reservation-reconcile-handler.ts), each up to HOSTAWAY_PAGINATION_MAX_PAGES
 * pages, each page bounded by PMS_API_TIMEOUT_MS. `x2` covers both walks;
 * +10 minutes margin covers the surrounding step overhead (token read,
 * cursor write, DB upserts) that runs inside the locked window but is not
 * page-fetching.
 *
 * No self-extending heartbeat here: nothing in this codebase renews a lock
 * mid-hold today (lib/integrations/refresh-lock.ts's locks are held for one
 * bounded call, not a multi-step pagination walk), and threading a renewal
 * call into lib/integrations/providers/hostaway.ts's page loop would couple
 * a low-level HTTP client to a cross-function locking concern several layers
 * above it. A generous TTL is the documented fallback for exactly this case.
 */
export const HOSTAWAY_SYNC_LOCK_TTL_SECONDS =
  Math.ceil((2 * HOSTAWAY_PAGINATION_MAX_PAGES * PMS_API_TIMEOUT_MS) / 1_000) + 600
