'use client'
import { useEffect, useState, useTransition, useSyncExternalStore } from 'react'
import Link                         from 'next/link'
import { usePathname, useRouter }   from 'next/navigation'
import { CalendarCheck, CalendarDays, MessageSquare, LogOut, Bell, X, HelpCircle, WifiOff, Wrench } from 'lucide-react'
import { useLiveQuery }             from 'dexie-react-hooks'
import { DexieProvider, useDexieDb } from '@/lib/dexie/context'
import { CrewContext }              from '@/lib/crew/crew-context'
import { closeDexieDb }             from '@/lib/dexie/schema'
import { getSyncEngine }            from '@/lib/dexie/syncService'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import { createClient }             from '@/lib/supabase/client'
import { cn }                       from '@/lib/utils'
import { InstallBanner }            from '@/components/pwa/install-banner'
import { Dialog }                   from '@/components/ui/Dialog'

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
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [swReg, setSwReg]               = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)
  const [showInfo, setShowInfo]         = useState(false)

  async function handleLogout() {
    await closeDexieDb()
    const supabase = createClient()
    await supabase.auth.signOut()
    startTransition(() => router.push('/login?next=/crew'))
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

  // Request persistent storage so the browser is less likely to evict
  // queued offline photos/mutations under storage pressure — iOS Safari in
  // particular applies eviction more aggressively to "best-effort" storage
  // than Chrome/Android does. Best-effort itself (the browser may decline,
  // e.g. if the user hasn't interacted enough with the site yet) — this is
  // additive and never blocks anything if it's unavailable or declined.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return
    navigator.storage.persist().catch((err) => {
      console.warn('[crew-shell] persistent storage request failed (non-fatal):', err)
    })
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
    if (!userId) return
    const supabase = createClient()

    const run = async () => {
      await getSyncEngine(userId).processOutbox()
      await processPendingPhotoUploads(supabase, userId)
    }

    run()  // attempt once on mount, in case items were queued in a prior session
    window.addEventListener('online', run)
    const interval = setInterval(run, 30_000)

    return () => {
      window.removeEventListener('online', run)
      clearInterval(interval)
    }
  }, [userId])

  return (
    <CrewContext.Provider value={{ crewName, userId }}>
    <DexieProvider userId={userId}>
      <div className="min-h-screen bg-canvas-themed flex flex-col max-w-lg mx-auto">
        {/* ── Branded header ─────────────────────────────────────────────── */}
        <header
          className="relative sticky top-0 z-10"
          style={{ background: '#0D1F3C', padding: '16px 16px 12px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0 }}>
            <span style={{ color: '#FFFFFF', fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>
              Field
            </span>
            <span style={{ color: '#FCD116', fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>
              Stay
            </span>
          </div>
          <p style={{ color: '#FFFFFF', fontSize: 11, textAlign: 'center', opacity: 0.7, marginTop: 2 }}>
            Crew Ops
          </p>

          {/* Sync status + logout — pinned right, vertically centered */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-3">
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

        {showInfo && <CrewFaqPanel onClose={() => setShowInfo(false)} />}

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
        <CrewBottomNav userId={userId} onHelpClick={() => setShowInfo(true)} />
      </div>
    </DexieProvider>
    </CrewContext.Provider>
  )
}

function CrewBottomNav({ userId, onHelpClick }: { userId: string; onHelpClick: () => void }) {
  const pathname = usePathname()
  const db = useDexieDb()

  const unreadCount = useLiveQuery(
    () => db.messages
      .where('recipient_id').equals(userId)
      .filter((m) => !m.read_at)
      .count(),
    [userId]
  ) ?? 0

  const tabs = [
    { href: '/crew',              label: 'Assignments',  icon: CalendarCheck },
    { href: '/crew/assets',       label: 'Assets',        icon: Wrench },
    { href: '/crew/availability', label: 'Time Off',     icon: CalendarDays },
    { href: '/crew/messages',     label: 'Messages',     icon: MessageSquare, badge: unreadCount },
  ]

  return (
    <nav className="sticky bottom-0 bg-card-themed border-t border-themed flex items-center">
      {tabs.map(({ href, label, icon: Icon, badge }) => {
        const active = href === '/crew' ? pathname === '/crew' : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'relative flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors',
              active ? 'text-brand-800' : 'text-muted-themed hover:text-secondary-themed'
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

      {/* Support — opens FAQ panel */}
      <button
        onClick={onHelpClick}
        className="flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium text-muted-themed hover:text-secondary-themed transition-colors"
      >
        <HelpCircle className="w-5 h-5" />
        Help
      </button>
    </nav>
  )
}

function subscribeToOnlineStatus(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function SyncStatus() {
  // Render `true` (no banner) on both the server and the initial client
  // paint — reading navigator.onLine during SSR would diverge from the
  // client, causing a hydration mismatch. getServerSnapshot below covers
  // that; the real value is synced in as soon as the client mounts.
  const isOnline = useSyncExternalStore(subscribeToOnlineStatus, () => navigator.onLine, () => true)
  const [showInfo, setShowInfo] = useState(false)

  if (isOnline) return null
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
        <Dialog open onClose={() => setShowInfo(false)} title="You're offline" mobileSheet maxWidthClassName="max-w-sm">
          <div className="flex items-center gap-3 mb-3">
            <span
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
            >
              <WifiOff className="w-5 h-5" />
            </span>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Working from cached data
            </p>
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
        </Dialog>
      )}
    </>
  )
}

// ── Info / FAQ bottom sheet ────────────────────────────────────────────────────

function CrewFaqPanel({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="FieldStay Crew App — FAQ" mobileSheet>
      {FAQ_ITEMS.map((item, i) => (
        <FaqItem key={i} question={item.q} answer={item.a} />
      ))}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid #e2e8f0' }}>
        <p style={{ fontSize: 12, color: '#64748b', textAlign: 'center' }}>
          Need help?{' '}
          <a href="mailto:help@fieldstay.app" style={{ color: '#0D1F3C', fontWeight: 700 }}>
            help@fieldstay.app
          </a>
        </p>
      </div>
    </Dialog>
  )
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: '1px solid #f1f5f9', paddingBottom: 12, marginBottom: 12 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          width: '100%', textAlign: 'left', gap: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b', flex: 1 }}>
          {question}
        </span>
        <span style={{ color: '#94a3b8', flexShrink: 0 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, marginTop: 8 }}>
          {answer}
        </p>
      )}
    </div>
  )
}

const FAQ_ITEMS = [
  {
    q: 'What do the icons on checklist items mean?',
    a: 'The note icon on a checklist item means your property manager has added specific instructions for that task. Tap it to read what they need done — it could be details about a specific area, a known quirk of the property, or a special request from the owner.',
  },
  {
    q: 'Why does the app ask me to install it and turn on notifications?',
    a: 'Installing the app adds a FieldStay icon to your home screen — just like any app from the App Store or Google Play. Turning on notifications means you\'ll know the moment a new turnover or work order is assigned to you, without having to open the app to check.',
  },
  {
    q: 'Does the app work without cell service or WiFi?',
    a: 'Yes. FieldStay Crew Ops is built to work offline. If you\'re at a property with no signal, the app will continue to work normally — you can complete checklists, count inventory, and take photos. Everything syncs automatically once you\'re back online.',
  },
  {
    q: 'Why are we photographing manufacturer stickers and data plates on appliances?',
    a: 'Three reasons. First, we use that information to build a resource guide for guests (for example, how to operate the dishwasher). Second, knowing the age and model of appliances helps the owner plan for replacements before they become expensive emergencies. Third, we build a service database so that when a vendor gets a work order, they already have the make, model, and serial number — which means faster parts ordering and faster repairs.',
  },
  {
    q: 'What is a par level and why does it matter?',
    a: 'A par level is the minimum quantity of an item — paper towels, trash bags, laundry pods — that needs to be on hand before we reorder. You\'re the person who sees these items at every turnover, which makes your count the most accurate data we have. If a par level seems too low or too high for a property, let your PM know — your input directly changes what gets ordered.',
  },
  {
    q: 'What if inventory is being counted in the wrong unit?',
    a: 'Let your PM know using the notes field on that inventory item (preferred), or send them an in-app message. The unit matters because your count is used to automatically populate a restock order — if the unit is wrong, the wrong quantity gets ordered.',
  },
  {
    q: 'Why does inventory accuracy matter so much?',
    a: 'The numbers you enter are used to fill an actual shopping cart or generate a purchase order to restock the property. An inaccurate count means either too much is ordered (waste) or not enough (the next guest arrives to find empty shelves). Your count is the direct input to that process.',
  },
]
