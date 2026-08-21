'use client'

import { useEffect, useState } from 'react'

import { reportError } from '@/lib/observability/report-error'
import { registerAndSyncPush, subscribeToPush } from '@/lib/push/subscribe-client'

const ENDPOINT = '/api/dashboard/push-subscribe' as const

/**
 * Registers the origin-wide service worker for push on mount (no permission
 * prompt yet) and exposes a flag + action for prompting the user to enable
 * notifications when permission hasn't been decided.
 *
 * ⚠️ This runs from components/dashboard-shell.tsx, which wraps EVERY dashboard
 * page — so `/sw.js` is registered at root scope for every PM on every page
 * load, before any opt-in. That is why public/sw.js carries an explicit
 * offline-path allowlist: without one, its navigate handler cached every
 * dashboard page a PM visited and served it back whenever the network failed.
 *
 * The subscription flow lives in lib/push/subscribe-client.ts, shared with the
 * crew PWA. It used to be a second copy here, and the copy missed every fix the
 * crew one received — most consequentially `if (existing) return`, which meant
 * a device whose crew PWA had already subscribed never registered its PM row.
 * push_subscriptions held zero PM rows, ever, with no error anywhere because
 * the code returned before it could produce one.
 */
export function useDashboardPushNotifications() {
  const [swReg, setSwReg]               = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)

  useEffect(() => {
    if (typeof globalThis.window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) return

    const run = async () => {
      try {
        const { registration, shouldPrompt } = await registerAndSyncPush(ENDPOINT)
        setSwReg(registration)
        setNotifVisible(shouldPrompt)
      } catch (err) {
        console.error('[sw] dashboard registration failed:', err)
        reportError(err, { site: 'lib.hooks.use-dashboard-push-notifications.sw' })
      }
    }

    run()
  }, [])

  async function enableNotifications() {
    if (!swReg) return
    const permission = await Notification.requestPermission()
    setNotifVisible(false)
    if (permission !== 'granted') return
    try {
      await subscribeToPush(swReg, ENDPOINT)
    } catch (err) {
      console.error('[push] dashboard subscription failed:', err)
      reportError(err, { site: 'lib.hooks.use-dashboard-push-notifications.push' })
    }
  }

  return { notifVisible, enableNotifications }
}
