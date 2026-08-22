'use client'

import { useEffect } from 'react'

import { cleanupStaleDashboardDbs } from './schema'

/**
 * Deletes any dashboard cache on this device that does not belong to the
 * (user, org) pair now signed in. Mounted once by the dashboard layout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MOUNT-TIME SWEEP AND NOT AN ORG-SWITCH HANDLER
 *
 * docs/INSPECTIONS_SPEC.md §8 asks for a cache "cleared on sign-out, and
 * cleared on org switch". There is no org-switch flow in the product today —
 * a PM's org comes from `requireOrgMember()`, one membership per session — so
 * there is no event to hang a handler on, and writing one would be inventing a
 * trigger nothing fires.
 *
 * Keying the database name on both ids and sweeping on mount gets the same
 * guarantee without the event, and is the sturdier of the two anyway: the org a
 * PM resolves to can change without any "switch" ever happening — they are
 * removed from one org and added to another, and the next page load simply
 * resolves differently. An event-based clear would miss that case completely;
 * this one cannot, because it asks "is this cache still mine?" rather than
 * "did something happen?".
 *
 * Non-blocking and non-fatal. A cleanup that fails, or a database another tab
 * holds open, must never keep a PM out of their own dashboard — the sweep runs
 * again on the next mount.
 */
export function DashboardCacheGuard({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  useEffect(() => {
    void cleanupStaleDashboardDbs(userId, orgId)
  }, [userId, orgId])

  return null
}
