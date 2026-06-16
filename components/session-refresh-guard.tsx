'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Proactively refreshes the Supabase JWT before it expires.
 *
 * Supabase JWTs expire after 1 hour by default. This component:
 *   1. Refreshes on a 45-minute interval while the tab is alive.
 *   2. Refreshes immediately when the user returns to the browser
 *      after backgrounding it (visibilitychange event).
 *
 * This fixes the OwnerRez "disconnected" state that appears when
 * the user leaves the mobile browser for over an hour — the
 * OwnerRez token in Vault is unaffected; only the Supabase session
 * needs refreshing.
 */
export function SessionRefreshGuard() {
  useEffect(() => {
    const supabase = createClient()
    const REFRESH_INTERVAL_MS = 45 * 60 * 1000 // 45 minutes

    async function refreshSession() {
      const { error } = await supabase.auth.refreshSession()
      if (error) {
        console.warn('[SessionRefreshGuard] Refresh failed:', error.message)
      }
    }

    const interval = setInterval(refreshSession, REFRESH_INTERVAL_MS)

    // Fire immediately when returning from background.
    // This is the critical path for the mobile use case.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        refreshSession()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return null
}
