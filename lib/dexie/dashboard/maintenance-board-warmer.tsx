'use client'

import { useEffect } from 'react'

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
 */
export function MaintenanceBoardWarmer({ userId, orgId }: Readonly<{ userId: string; orgId: string }>) {
  useEffect(() => {
    void warmMaintenanceBoardForOffline(userId, orgId)

    const onOnline = () => { void warmMaintenanceBoardForOffline(userId, orgId) }
    globalThis.addEventListener?.('online', onOnline)
    return () => globalThis.removeEventListener?.('online', onOnline)
  }, [userId, orgId])

  return null
}
