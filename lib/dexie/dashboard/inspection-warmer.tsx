'use client'

import { useEffect } from 'react'

import { reconnectDelayWithJitterMs } from '../sync/signals'
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE RECONNECT WARM IS JITTERED
 *
 * A fleet-wide outage recovers at one instant for every device on it, and
 * `online` fires on all of them at once. Warming immediately on that event
 * turns "the backend came back" into a synchronized request stampede from
 * every PM's tablet in the same second — exactly the herd `online`'s own
 * comment in lib/dexie/context.tsx already spreads out for the crew realtime
 * reconnect, via `reconnectDelayWithJitterMs()`. Reused here rather than
 * inventing a second jitter formula for the same problem.
 */
export function InspectionWarmer({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  useEffect(() => {
    void warmInspectionsForOffline(userId, orgId)

    // Also on reconnect. A tablet that woke up on a hotel wifi has a window to
    // catch up that the next mount may not provide — the PM may already be
    // driving, with the app open the whole time. Jittered — see above.
    let timer: ReturnType<typeof setTimeout> | null = null
    const onOnline = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void warmInspectionsForOffline(userId, orgId) }, reconnectDelayWithJitterMs())
    }
    globalThis.addEventListener?.('online', onOnline)
    return () => {
      globalThis.removeEventListener?.('online', onOnline)
      if (timer) clearTimeout(timer)
    }
  }, [userId, orgId])

  return null
}
