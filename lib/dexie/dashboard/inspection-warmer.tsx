'use client'

import { useEffect } from 'react'

import { warmInspectionsForOffline } from './warm-inspections'

/**
 * Keeps every open inspection ready to work offline, from anywhere in the
 * dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE LAYOUT AND NOT THE INSPECTIONS PAGE
 *
 * The whole point is that the PM should not have to visit anything first. If
 * this only ran on /maintenance/inspections, the precondition for working
 * offline would be "open the inspections list before you leave" — a rule nobody
 * is told and nobody would remember, and one whose violation only shows up at
 * the property.
 *
 * Mounted in the layout, any dashboard page the PM touches on their way out the
 * door is enough. It is throttled to a 15-minute watermark in `sync_meta`, so
 * "any page" does not mean "every navigation".
 *
 * Non-blocking and non-fatal, like DashboardCacheGuard beside it. A warm that
 * fails leaves the device exactly where it was.
 */
export function InspectionWarmer({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  useEffect(() => {
    void warmInspectionsForOffline(userId, orgId)

    // Also on reconnect. A tablet that woke up on a hotel wifi has a window to
    // catch up that the next mount may not provide — the PM may already be
    // driving, with the app open the whole time.
    const onOnline = () => { void warmInspectionsForOffline(userId, orgId) }
    globalThis.addEventListener?.('online', onOnline)
    return () => globalThis.removeEventListener?.('online', onOnline)
  }, [userId, orgId])

  return null
}
