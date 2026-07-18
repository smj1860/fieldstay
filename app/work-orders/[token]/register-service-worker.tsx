'use client'

import { useEffect } from 'react'

// Registers the same origin-wide service worker the crew/dashboard PWAs use
// (public/sw.js) — its fetch handler already caches any navigation it's
// seen and falls back to /offline.html for one it hasn't, with no path
// scoping of its own. Nothing registers it anywhere in this route tree
// today, so a vendor who loses signal and hard-reloads (tab killed by the
// OS, not just backgrounded) got nothing instead of the cached page. No
// push-notification tie-in here — vendors have no account to send push to,
// this is caching-only.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('[work-orders] service worker registration failed:', err)
    })
  }, [])

  return null
}
