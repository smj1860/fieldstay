'use client'

import { useEffect }     from 'react'
import { useRouter }     from 'next/navigation'
import { createClient }  from '@/lib/supabase/client'

/**
 * Public SECTIONS — these match the path itself and anything beneath it,
 * because each has token-bearing children (`/owner/<token>`,
 * `/work-orders/<token>`, `/accept-invite/<token>`).
 */
const PUBLIC_PREFIXES = ['/login', '/signup', '/forgot-password',
  '/reset-password', '/accept-invite', '/crew-invite', '/owner',
  '/work-orders']

/**
 * The marketing home page, and ONLY it.
 *
 * `'/'` used to live in the prefix list above, and since every absolute path
 * begins with `'/'`, `startsWith` made isPublicPath() return true for
 * literally every route in the app. The redirect half of this component —
 * every branch that sends a lapsed session back to login — had therefore never
 * executed once since it was written. It is why the 2026-09-11 tab could sit
 * signed out on /maintenance for 10.5 hours: even had a wake signal fired, the
 * guard would have decided /maintenance was a public page and done nothing.
 *
 * A prefix also needs a segment boundary, or `/loginhelp` would count as
 * `/login`. Hence `${p}/` rather than a bare startsWith.
 */
const PUBLIC_EXACT = ['/']

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Proactively refreshes the Supabase JWT before it expires, and redirects
 * to login if the session is gone or can't be refreshed.
 *
 * Supabase JWTs expire after 1 hour by default. This component:
 *   1. Refreshes on a 45-minute interval while the tab is alive.
 *   2. Refreshes immediately when the user returns to the browser
 *      after backgrounding it (visibilitychange event).
 *   3. Refreshes immediately when the network comes back (online event).
 *
 * This fixes the OwnerRez "disconnected" state that appears when
 * the user leaves the mobile browser for over an hour — the
 * OwnerRez token in Vault is unaffected; only the Supabase session
 * needs refreshing.
 *
 * If the session is missing or fails to refresh on a protected route,
 * redirect to login rather than leaving the user in a broken offline
 * state with no explanation (Dexie's SyncEngine can't authenticate either).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY 'online' IS HERE, ADDED 2026-09-11
 *
 * It was the one wake signal this guard did not listen for, and the dashboard
 * warmers DO. That asymmetry is not academic: a laptop asleep on /maintenance
 * runs no timers, and waking it with the tab already frontmost fires `online`
 * without firing `visibilitychange`. So the warmers re-ran on a session that had
 * expired hours earlier while this guard sat waiting for a 45-minute tick that
 * had not started counting, and the PM kept reading a board that had quietly
 * stopped updating.
 *
 * That is exactly what produced 12 Sentry issues on 2026-09-11 — five tables'
 * worth of 42501 across two bursts 10.5 hours apart, ALL CARRYING ONE TRACE ID,
 * which is what proved it was a single tab that was never reloaded rather than
 * an RLS regression. The warmers now decline to run unauthenticated
 * (lib/dexie/dashboard/session-gate.ts), so without this listener the same tab
 * would fail SILENTLY instead of loudly — a strictly worse outcome for the
 * person in front of it. This is the half that gets them signed back in.
 *
 * THE REFRESHES ARE SERIALISED, and that matters more than it looks. Waking a
 * machine can fire `online` and `visibilitychange` together; two concurrent
 * refreshSession() calls race on a refresh token that ROTATES, so the loser can
 * present a token the server has already retired and fail — manufacturing the
 * dead session this component exists to prevent. One in-flight refresh at a
 * time, and the second caller awaits the first's result.
 */
export function SessionRefreshGuard() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    const REFRESH_INTERVAL_MS = 45 * 60 * 1000 // 45 minutes

    /**
     * Send the user to the right login entry point, if they are somewhere that
     * needs one. A public page (login, invite, owner portal) does nothing.
     */
    function redirectToLogin() {
      const pathname = globalThis.location.pathname
      if (isPublicPath(pathname)) return
      // Detect crew vs PM and redirect to the correct login entry point
      const loginPath = pathname.startsWith('/crew')
        ? `/login?next=/crew`
        : `/login?next=${encodeURIComponent(pathname)}`
      router.push(loginPath)
    }

    async function doRefresh() {
      // Check if there's a session before attempting refresh —
      // avoids noisy warnings on public/unauthenticated pages
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        redirectToLogin()
        return
      }

      const { error } = await supabase.auth.refreshSession()
      if (error) {
        console.warn('[SessionRefreshGuard] Refresh failed:', error.message)
        // If refresh fails on a protected route, redirect rather than
        // leaving the user in a broken offline state with no explanation
        redirectToLogin()
      }
    }

    // One refresh at a time. See the note above: the refresh token ROTATES, so
    // two concurrent refreshes race and the loser presents a token the server
    // has already retired — manufacturing the dead session this prevents.
    // Waking a machine can fire 'online' and 'visibilitychange' together, which
    // is precisely when that race would happen.
    let inFlight: Promise<void> | null = null
    function refreshSession(): Promise<void> {
      inFlight ??= doRefresh().finally(() => { inFlight = null })
      return inFlight
    }

    const interval = setInterval(refreshSession, REFRESH_INTERVAL_MS)

    // Fire immediately when returning from background.
    // This is the critical path for the mobile use case.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void refreshSession()
      }
    }

    // And when the network returns. A machine waking with the tab already
    // frontmost fires this and NOT visibilitychange, and its timers did not run
    // while it slept — so without this the tab has no wake signal at all.
    function handleOnline() {
      void refreshSession()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    globalThis.addEventListener?.('online', handleOnline)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      globalThis.removeEventListener?.('online', handleOnline)
    }
  }, [router])

  return null
}
