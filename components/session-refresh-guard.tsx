'use client'

import { useEffect }     from 'react'
import { useRouter }     from 'next/navigation'
import { createClient }  from '@/lib/supabase/client'

const PUBLIC_PATHS = ['/', '/login', '/signup', '/forgot-password',
  '/reset-password', '/accept-invite', '/crew-invite', '/owner',
  '/work-orders/']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p))
}

/**
 * Proactively refreshes the Supabase JWT before it expires, and redirects
 * to login if the session is gone or can't be refreshed.
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
 *
 * If the session is missing or fails to refresh on a protected route,
 * redirect to login rather than leaving the user in a broken offline
 * state with no explanation (Dexie's SyncEngine can't authenticate either).
 */
export function SessionRefreshGuard() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    const REFRESH_INTERVAL_MS = 45 * 60 * 1000 // 45 minutes

    async function refreshSession() {
      // Check if there's a session before attempting refresh —
      // avoids noisy warnings on public/unauthenticated pages
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        // Only redirect if currently on a protected route — if already
        // on a public page (login, invite, etc.) do nothing
        if (!isPublicPath(window.location.pathname)) {
          const next = encodeURIComponent(window.location.pathname)
          // Detect crew vs PM and redirect to the correct login entry point
          const loginPath = window.location.pathname.startsWith('/crew')
            ? `/login?next=/crew`
            : `/login?next=${next}`
          router.push(loginPath)
        }
        return
      }

      const { error } = await supabase.auth.refreshSession()
      if (error) {
        console.warn('[SessionRefreshGuard] Refresh failed:', error.message)
        // If refresh fails on a protected route, redirect rather than
        // leaving the user in a broken offline state with no explanation
        if (!isPublicPath(window.location.pathname)) {
          const loginPath = window.location.pathname.startsWith('/crew')
            ? `/login?next=/crew`
            : `/login?next=${encodeURIComponent(window.location.pathname)}`
          router.push(loginPath)
        }
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
  }, [router])

  return null
}
