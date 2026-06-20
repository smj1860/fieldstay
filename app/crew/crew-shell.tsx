'use client'
import { useEffect, useState, useTransition } from 'react'
import Link                         from 'next/link'
import { usePathname, useRouter }   from 'next/navigation'
import { CalendarCheck, CalendarDays, MessageSquare, LogOut, Bell, X } from 'lucide-react'
import { PowerSyncContext }         from '@powersync/react'
import { usePowerSync, usePowerSyncQuery } from '@powersync/react'
import { getPowerSyncDb, disconnectPowerSync } from '@/lib/powersync/client'
import { createClient }             from '@/lib/supabase/client'
import { processPendingPhotoUploads } from '@/lib/powersync/photo-sync'
import { cn }                       from '@/lib/utils'
import { InstallBanner }            from '@/components/pwa/install-banner'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

async function subscribeToPush(reg: ServiceWorkerRegistration) {
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
}

export function CrewShell({
  crewName,
  userId,
  children,
}: {
  crewName: string
  userId:   string
  children: React.ReactNode
}) {
  const db     = getPowerSyncDb(userId)
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [swReg, setSwReg]               = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)

  async function handleLogout() {
    await disconnectPowerSync()
    const supabase = createClient()
    await supabase.auth.signOut()
    startTransition(() => router.push('/crew/login'))
  }

  // Register SW silently on mount — no permission prompt
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

    const register = async () => {
      try {
        const reg      = await navigator.serviceWorker.register('/sw.js')
        setSwReg(reg)

        const existing = await reg.pushManager.getSubscription()
        if (existing) return // Already subscribed — nothing to do

        const permission = Notification.permission
        if (permission === 'default') {
          setNotifVisible(true) // Show "Enable Notifications" prompt
        } else if (permission === 'granted') {
          // Previously granted but subscription was lost — resubscribe silently
          await subscribeToPush(reg)
        }
        // 'denied' — respect the user's choice, don't prompt
      } catch (err) {
        console.error('[sw] registration failed:', err)
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
      await subscribeToPush(swReg)
    } catch (err) {
      console.error('[push] subscription failed:', err)
    }
  }

  useEffect(() => {
    const supabase = createClient()
    const run = () => { void processPendingPhotoUploads(db, supabase) }

    run()  // attempt once on mount, in case items were queued in a prior session
    window.addEventListener('online', run)
    const interval = setInterval(run, 30_000)

    return () => {
      window.removeEventListener('online', run)
      clearInterval(interval)
    }
  }, [db])

  return (
    <PowerSyncContext.Provider value={db}>
      <div className="min-h-screen bg-accent-50 flex flex-col max-w-lg mx-auto">
        <header className="bg-brand-800 text-white px-4 py-4 flex items-center justify-between sticky top-0 z-10">
          <div>
            <span className="font-bold text-lg">FieldStay Crew</span>
            <p className="text-brand-200 text-xs">{crewName}</p>
          </div>
          <div className="flex items-center gap-3">
            <SyncStatus />
            <button
              onClick={handleLogout}
              disabled={isPending}
              aria-label="Log out"
              className="text-brand-200 hover:text-white transition-colors disabled:opacity-50"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        <InstallBanner />

        {notifVisible && (
          <div
            className="mx-4 mt-2 rounded-xl p-4 flex items-center gap-3"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
          >
            <Bell className="w-5 h-5 shrink-0" style={{ color: 'var(--accent-gold)' }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Stay in the loop
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Get notified when you&apos;re assigned a new job.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setNotifVisible(false)}
                aria-label="Dismiss notification prompt"
                className="p-1 rounded-lg transition-opacity active:opacity-60"
                style={{ color: 'var(--text-muted)' }}
              >
                <X className="w-4 h-4" />
              </button>
              <button
                onClick={enableNotifications}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity active:opacity-80"
                style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
              >
                Enable
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 px-4 py-6">{children}</main>
        <CrewBottomNav userId={userId} />
      </div>
    </PowerSyncContext.Provider>
  )
}

function CrewBottomNav({ userId }: { userId: string }) {
  const pathname = usePathname()

  const unread = usePowerSyncQuery<{ count: number }>(
    `SELECT COUNT(*) as count FROM messages WHERE recipient_id = ? AND read_at IS NULL`,
    [userId]
  )
  const unreadCount = unread?.[0]?.count ?? 0

  const tabs = [
    { href: '/crew',              label: 'Assignments',  icon: CalendarCheck },
    { href: '/crew/availability', label: 'Time Off',     icon: CalendarDays },
    { href: '/crew/messages',     label: 'Messages',     icon: MessageSquare, badge: unreadCount },
  ]

  return (
    <nav className="sticky bottom-0 bg-white border-t border-accent-200 flex items-center">
      {tabs.map(({ href, label, icon: Icon, badge }) => {
        const active = href === '/crew' ? pathname === '/crew' : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'relative flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors',
              active ? 'text-brand-800' : 'text-accent-400 hover:text-accent-600'
            )}
          >
            <span className="relative">
              <Icon className="w-5 h-5" />
              {!!badge && badge > 0 && (
                <span className="absolute -top-1.5 -right-2 bg-red-500 text-white text-[10px] leading-none rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </span>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

function SyncStatus() {
  const db = usePowerSync()
  const connected = db?.currentStatus?.connected
  const [showInfo, setShowInfo] = useState(false)

  if (connected) return null
  return (
    <>
      <button
        onClick={() => setShowInfo(true)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-opacity active:opacity-70"
        style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
        Offline
      </button>

      {showInfo && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={() => setShowInfo(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative w-full rounded-t-2xl p-6 pb-10"
            style={{ background: 'var(--bg-card)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="w-10 h-1 rounded-full mx-auto mb-5"
              style={{ background: 'var(--border)' }}
            />
            <div className="flex items-center gap-3 mb-3">
              <span
                className="w-10 h-10 rounded-full flex items-center justify-center text-lg"
                style={{ background: 'var(--accent-gold-dim)' }}
              >
                📶
              </span>
              <div>
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  You&apos;re offline
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Working from cached data
                </p>
              </div>
            </div>
            <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
              Your assignments and checklists are saved on your device.
              You can complete turnovers and check off tasks without a
              signal — everything syncs automatically when you reconnect.
            </p>
            <button
              onClick={() => setShowInfo(false)}
              className="w-full py-3 rounded-xl text-sm font-semibold"
              style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}
