'use client'

import { useEffect } from 'react'

import { reconnectDelayWithJitterMs } from '../sync/signals'
import { warmMaintenanceBoardForOffline } from './warm-maintenance-board'

/**
 * Keeps the open work-order board ready to work offline, from anywhere in the
 * dashboard — same reasoning as InspectionWarmer beside it: the PM should not
 * have to visit the Maintenance page before losing signal for the board to be
 * there when they need it.
 *
 * Mounted in the layout rather than the maintenance page itself, and on
 * 'online' too, for the same reason InspectionWarmer is: a tablet that regains
 * signal for a moment on the drive over has a window to catch up that the next
 * mount may not provide.
 *
 * The reconnect warm is JITTERED for the same reason InspectionWarmer's is —
 * see its header comment: `online` fires on every device in the fleet at
 * once when a backend outage clears, and warming immediately turns that into
 * a synchronized request stampede. Reuses the same
 * `reconnectDelayWithJitterMs()` the crew realtime reconnect already spreads
 * its own herd with, rather than a second jitter formula for the same
 * problem.
 */
export function MaintenanceBoardWarmer({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  useEffect(() => {
    void warmMaintenanceBoardForOffline(userId, orgId)

    let timer: ReturnType<typeof setTimeout> | null = null
    const onOnline = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void warmMaintenanceBoardForOffline(userId, orgId) }, reconnectDelayWithJitterMs())
    }
    globalThis.addEventListener?.('online', onOnline)
    return () => {
      globalThis.removeEventListener?.('online', onOnline)
      if (timer) clearTimeout(timer)
    }
  }, [userId, orgId])

  return null
}
