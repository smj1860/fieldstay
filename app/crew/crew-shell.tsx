'use client'
import { useEffect }           from 'react'
import { PowerSyncContext }    from '@powersync/react'
import { usePowerSync }        from '@powersync/react'
import { getPowerSyncDb }      from '@/lib/powersync/client'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

export function CrewShell({
  crewName,
  children,
}: {
  crewName: string
  children: React.ReactNode
}) {
  const db = getPowerSyncDb()

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

    const register = async () => {
      try {
        const reg      = await navigator.serviceWorker.register('/sw.js')
        const existing = await reg.pushManager.getSubscription()
        if (existing) return

        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return

        const sub  = await reg.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
        })

        const json = sub.toJSON()
        if (!json.keys) return

        await fetch('/api/crew/push-subscribe', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            endpoint: json.endpoint,
            p256dh:   json.keys.p256dh,
            auth:     json.keys.auth,
          }),
        })
      } catch (err) {
        console.error('[push] registration failed:', err)
      }
    }

    register()
  }, [])

  return (
    <PowerSyncContext.Provider value={db}>
      <div className="min-h-screen bg-accent-50 flex flex-col max-w-lg mx-auto">
        <header className="bg-brand-800 text-white px-4 py-4 flex items-center justify-between sticky top-0 z-10">
          <div>
            <span className="font-bold text-lg">FieldStay Crew</span>
            <p className="text-brand-200 text-xs">{crewName}</p>
          </div>
          <SyncStatus />
        </header>
        <main className="flex-1 px-4 py-6">{children}</main>
      </div>
    </PowerSyncContext.Provider>
  )
}

function SyncStatus() {
  const db = usePowerSync()
  const connected = db?.currentStatus?.connected

  if (connected) return null
  return (
    <span className="bg-amber-400 text-amber-900 text-xs font-medium px-2 py-1 rounded-full">
      Offline
    </span>
  )
}
