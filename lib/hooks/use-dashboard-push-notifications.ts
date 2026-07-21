'use client'

import { useEffect, useState } from 'react'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = globalThis.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

async function subscribeToDashboardPush(reg: ServiceWorkerRegistration) {
  const sub  = await reg.pushManager.subscribe({
    userVisibleOnly:      true,
    applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
  })
  const json = sub.toJSON()
  if (!json.keys) return
  await fetch('/api/dashboard/push-subscribe', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      endpoint: json.endpoint,
      p256dh:   json.keys.p256dh,
      auth:     json.keys.auth,
    }),
  })
}

// Registers the dashboard's service worker for push on mount (no permission
// prompt yet) and exposes a flag + action for prompting the user to enable
// notifications when permission hasn't been decided. Extracted from
// DashboardShell.
export function useDashboardPushNotifications() {
  const [swReg, setSwReg]               = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

    const register = async () => {
      try {
        const reg      = await navigator.serviceWorker.register('/sw.js')
        setSwReg(reg)

        const existing = await reg.pushManager.getSubscription()
        if (existing) return

        const permission = Notification.permission
        if (permission === 'default') {
          setNotifVisible(true)
        } else if (permission === 'granted') {
          await subscribeToDashboardPush(reg)
        }
      } catch (err) {
        console.error('[sw] dashboard registration failed:', err)
      }
    }

    register()
  }, [])

  async function enableNotifications() {
    if (!swReg) return
    const permission = await Notification.requestPermission()
    setNotifVisible(false)
    if (permission !== 'granted') return
    try {
      await subscribeToDashboardPush(swReg)
    } catch (err) {
      console.error('[push] dashboard subscription failed:', err)
    }
  }

  return { notifVisible, enableNotifications }
}
