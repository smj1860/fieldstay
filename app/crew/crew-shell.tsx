'use client'
import { useEffect, useRef, useState, useTransition, useSyncExternalStore } from 'react'
import Link                         from 'next/link'
import { usePathname, useRouter }   from 'next/navigation'
import { CalendarCheck, CalendarDays, MessageSquare, LogOut, Bell, X, HelpCircle, WifiOff, Wrench } from 'lucide-react'
import { DexieProvider }           from '@/lib/dexie/context'
import { CrewContext }              from '@/lib/crew/crew-context'
import { closeDexieDb, listenForRemoteShutdown, markDexieShutdown, resumeDexieDb } from '@/lib/dexie/schema'
import { getSyncEngine, disposeSyncEngine } from '@/lib/dexie/syncService'
import { processPendingPhotoUploads } from '@/lib/dexie/photo-sync'
import { countPendingSyncWork }      from '@/lib/dexie/prune'
import { isOnline }                  from '@/lib/dexie/net'
import { FailedSyncBanner }          from './_components/failed-sync-banner'
import { createClient }             from '@/lib/supabase/client'
import { cn }                       from '@/lib/utils'
import { InstallBanner }            from '@/components/pwa/install-banner'
import { Dialog }                   from '@/components/ui/Dialog'

import { reportError } from '@/lib/observability/report-error'
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = globalThis.atob(base64)
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
  unreadCount,
  children,
}: {
  crewName:     string
  userId:       string
  /** Server-rendered — see the note in CrewBottomNav. */
  unreadCount?: number | null
  children:     React.ReactNode
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [swReg, setSwReg]               = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)
  const [showInfo, setShowInfo]         = useState(false)
  const [loggingOut, setLoggingOut]             = useState(false)
  const [unsyncedCount, setUnsyncedCount]       = useState(0)
  const [showUnsyncedWarning, setShowUnsyncedWarning] = useState(false)
  // Flips the moment logout starts tearing down local storage. Depended on by
  // the background-drain effect below so React runs that effect's cleanup —
  // removing the 'online' listener and clearing the 30 s interval — AT LOGOUT
  // rather than whenever this component eventually unmounts. Restoring
  // connectivity is part of the logout flow itself ("Log Out Anyway" is
  // clicked once the device is back online), so those two entry points fire
  // during the teardown, not safely after it.
  const [signedOut, setSignedOut] = useState(false)

  // A logout latches this user's local database as deleted (markDexieShutdown,
  // see performLogout) and that latch is module state, so it outlives the
  // client-side navigation to /login. Mounting CrewShell again means the crew
  // layout re-authenticated a session for this user, which is exactly when the
  // latch must be lifted. Done on the FIRST render rather than in an effect
  // because DexieProvider — a child, rendered before any effect runs — asks
  // for the database handle during render, and would otherwise hold a dead
  // one for the whole new session. Deliberately once per mount: re-running it
  // on every render would clear the latch the logout re-render just set.
  const resumedRef = useRef<string | null>(null)
  if (resumedRef.current === null) {
    resumedRef.current = userId
    resumeDexieDb(userId)
  }

  /**
   * performLogout() deletes all local Dexie/photo-queue storage for this
   * device (see below) — anything still sitting in the offline outbox at
   * that moment is gone for good, not just delayed. requestLogout() checks
   * for that first: if there's a connection, it gives any queued work one
   * last bounded chance to drain, then re-checks. If anything is still
   * unsynced after that, it blocks with a confirmation instead of wiping
   * silently.
   *
   * This DOES now cover crew messages. Sending one used to be a live Server
   * Action, so a message that failed to send was never written to
   * db.mutations and this count could not see it — messages were the one
   * crew-facing action that wasn't offline-safe. They go through
   * queueMessageToPM() and the outbox now, so they are counted here like
   * every other queued write.
   */
  async function requestLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      if (navigator.onLine) {
        const supabase = createClient()
        // Best-effort final flush, bounded so a hung request can't leave
        // the logout button stuck. Whatever doesn't finish in time simply
        // stays in the pending count checked right below.
        await Promise.race([
          Promise.all([
            getSyncEngine(userId).processOutbox(),
            processPendingPhotoUploads(supabase, userId),
          ]),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ])
      }

      // Counts work that is genuinely still on its way to the server.
      // Dead-lettered rows are deliberately EXCLUDED: they'll never drain on
      // their own, so counting them meant one ancient permanently-failed row
      // fired this warning on every logout forever — training crew to click
      // through the one dialog that exists to stop them destroying real work.
      // They get their own actionable surface instead (FailedSyncBanner),
      // which the user must retry or explicitly discard.
      const { pending } = await countPendingSyncWork(userId)

      if (pending > 0) {
        setUnsyncedCount(pending)
        setShowUnsyncedWarning(true)
        return
      }

      await performLogout()
    } finally {
      setLoggingOut(false)
    }
  }

  async function performLogout() {
    // Order matters, and none of these three steps is redundant:
    //
    //  1. markDexieShutdown() latches the user's local database as gone. Every
    //     drain/sync entry point checks it and refuses to open storage, so a
    //     drain that is ALREADY mid-await, or one started afterwards by the
    //     'online' event / 30 s interval / safety poll, cannot re-create the
    //     database. Must precede the delete, not follow it.
    //  2. setSignedOut(true) tears down this component's own 'online' listener
    //     and interval via the effect cleanup below, instead of leaving them
    //     armed until unmount.
    //  3. disposeSyncEngine() stops the outbox retry timer and drops the
    //     module-level engine.
    markDexieShutdown(userId)
    setSignedOut(true)
    disposeSyncEngine()
    await closeDexieDb()
    // Also clear the service worker's cached app shell — same "no residual
    // data on a shared device after sign-out" principle as the Dexie
    // delete above. The cached HTML can embed the signed-out user's own
    // name/data (this layout renders it server-side), so a different crew
    // member logging in next shouldn't see it, even briefly, before their
    // own navigation repopulates the cache.
    if (typeof caches !== 'undefined') {
      try {
        await Promise.all([caches.delete('fieldstay-shell-v1'), caches.delete('fieldstay-assets-v1')])
      } catch (err) {
        console.error('[crew-shell] Failed to clear service worker cache on logout:', err)
        reportError(err, { site: 'page.crew.crew-shell.performLogout' })
      }
    }
    const supabase = createClient()
    await supabase.auth.signOut()
    startTransition(() => router.push('/login?next=/crew'))
  }

  // Register SW silently on mount — no permission prompt
  useEffect(() => {
    if (typeof globalThis.window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) return

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
        reportError(err, { site: 'page.crew.crew-shell.sw' })
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
      reportError(err, { site: 'page.crew.crew-shell.push' })
    }
  }

  // Logging out in ANOTHER tab has to end this one too. IndexedDB is a
  // per-origin resource but the shutdown latch is per-document module state,
  // so without this a sibling tab kept draining, kept re-creating the database
  // the logging-out tab had just deleted, and kept rendering the signed-out
  // crew member's assignments — and its open connection blocked that delete
  // outright, which is what left logout hanging with the user still signed in.
  useEffect(() => {
    if (!userId) return
    return listenForRemoteShutdown(userId, () => {
      setSignedOut(true)
      disposeSyncEngine()
      startTransition(() => router.push('/login?next=/crew'))
    })
  }, [userId, router])

  useEffect(() => {
    if (!userId || signedOut) return
    const supabase = createClient()

    // Both drains no-op internally while offline (lib/dexie/net.ts), so an
    // offline tick can never charge a retry for an attempt that never left
    // the device. Gating here as well just avoids the pointless work.
    const run = async () => {
      if (!isOnline() || signedOut) return
      await getSyncEngine(userId).processOutbox()
      await processPendingPhotoUploads(supabase, userId)
    }

    run()  // attempt once on mount, in case items were queued in a prior session
    globalThis.addEventListener('online', run)
    const interval = setInterval(run, 30_000)

    return () => {
      globalThis.removeEventListener('online', run)
      clearInterval(interval)
    }
  }, [userId, signedOut])

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
              onClick={requestLogout}
              disabled={isPending || loggingOut}
              aria-label="Log out"
              className="text-brand-200 hover:text-white transition-colors disabled:opacity-50"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {showInfo && <CrewFaqPanel onClose={() => setShowInfo(false)} />}

        {showUnsyncedWarning && (
          <Dialog
            open
            onClose={() => setShowUnsyncedWarning(false)}
            title="Unsynced work on this device"
            mobileSheet
            maxWidthClassName="max-w-sm"
            footer={
              <div className="flex flex-col gap-2 w-full">
                <button
                  onClick={() => setShowUnsyncedWarning(false)}
                  className="w-full py-3 rounded-xl text-sm font-semibold"
                  style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
                >
                  Stay Logged In
                </button>
                <button
                  onClick={() => { setShowUnsyncedWarning(false); void performLogout() }}
                  className="w-full py-3 rounded-xl text-sm font-semibold"
                  style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
                >
                  Log Out Anyway
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 mb-3">
              <span
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
              >
                <WifiOff className="w-5 h-5" />
              </span>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {unsyncedCount} item{unsyncedCount !== 1 ? 's' : ''} haven&rsquo;t reached FieldStay yet
              </p>
            </div>
            <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
              Logging out clears everything saved on this device. This work is
              only here, not on FieldStay&rsquo;s servers yet &mdash; if you log out
              now, it will be lost. Stay logged in until you have signal and it
              finishes syncing.
            </p>
          </Dialog>
        )}

        <FailedSyncBanner userId={userId} />

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
        <CrewBottomNav unreadCount={unreadCount ?? 0} onHelpClick={() => setShowInfo(true)} />
      </div>
    </DexieProvider>
    </CrewContext.Provider>
  )
}

/**
 * `unreadCount` is server-rendered by app/crew/layout.tsx and refreshes on
 * navigation. It used to be a Dexie live query, which was the only reason
 * `messages` had to be cached on the device at all — 500 rows every five
 * minutes to keep one number current. A badge does not need to be live.
 */
function CrewBottomNav({ unreadCount, onHelpClick }: { unreadCount: number; onHelpClick: () => void }) {
  const pathname = usePathname()

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
  globalThis.addEventListener('online', onChange)
  globalThis.addEventListener('offline', onChange)
  return () => {
    globalThis.removeEventListener('online', onChange)
    globalThis.removeEventListener('offline', onChange)
  }
}

function SyncStatus() {
  // Render `true` (no banner) on both the server and the initial client
  // paint — reading navigator.onLine during SSR would diverge from the
  // client, causing a hydration mismatch. getServerSnapshot below covers
  // that; the real value is synced in as soon as the client mounts.
  const online = useSyncExternalStore(subscribeToOnlineStatus, () => navigator.onLine, () => true)
  const [showInfo, setShowInfo] = useState(false)

  if (online) return null
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
        <Dialog
          open
          onClose={() => setShowInfo(false)}
          title="You're offline"
          mobileSheet
          maxWidthClassName="max-w-sm"
          footer={
            <button
              onClick={() => setShowInfo(false)}
              className="w-full py-3 rounded-xl text-sm font-semibold"
              style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
            >
              Got it
            </button>
          }
        >
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

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
          Need help?{' '}
          <a href="mailto:help@fieldstay.app" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
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
    <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          width: '100%', textAlign: 'left', gap: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
          {question}
        </span>
        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 8 }}>
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
  {
    q: 'Exactly what saves when I don’t have signal?',
    a: 'Checklist taps, crew notes, photos, inventory counts, starting or completing a turnover, completing a work order, messages to your operations team, and time-off requests all save to your phone instantly and sync automatically once you’re back online. The one thing that needs a connection is READING older messages — your conversation history loads live, so it may be blank until you’re back in range.',
  },
  {
    q: 'How do I know if something hasn’t synced yet?',
    a: 'An "Offline" pill appears at the top of the screen whenever your phone has no connection — that’s expected and nothing to worry about, and nothing is lost while it’s showing. If something genuinely couldn’t be saved to FieldStay, a red "didn’t sync" panel appears at the top of every screen listing exactly what’s stuck, with a Retry all button. Tap it once you’re back in range.',
  },
  {
    q: 'Do I need to keep the app open for things to sync, or does it happen in the background?',
    a: 'Keep the app open (or reopen it) once you’re back in coverage. It checks for a connection the moment you regain signal and again every 30 seconds while it’s open, but it doesn’t sync while fully closed in the background. If you finish a job with no signal, open the app again once you’re somewhere with service.',
  },
  {
    q: 'Will I lose my work if I close the app, restart my phone, or it crashes while I’m offline?',
    a: 'No — everything is saved to your phone as you go, not just held in memory. Reopening the app picks up right where you left off. The one thing that does clear your saved work is logging out, so don’t log out until you’re confident everything has synced.',
  },
  {
    q: 'Can I log out while I still have unsynced work?',
    a: 'The app will warn you first. If you try to log out with anything still unsynced, it’ll show you how many items and ask you to confirm — logging out anyway clears everything saved on that device, including anything that hasn’t synced yet. If you’re not sure, stay logged in until you’re somewhere with better signal and try again.',
  },
  {
    q: 'I finished a turnover on my phone — can I check it on a different phone or tablet later?',
    a: 'Not until it syncs. Offline work is saved to the specific device you entered it on, so it won’t show up anywhere else — including your PM’s dashboard — until that device gets a connection and pushes it up.',
  },
  {
    q: 'My coworker and I are splitting a turnover. If one of us has no signal, will we see each other’s checklist taps?',
    a: 'Not in real time — you’ll each only see what’s on your own phone until the offline one reconnects. The moment it does, it automatically pulls the latest state, so nothing gets lost, it just catches up rather than updating live.',
  },
  {
    q: 'Will I get notified if I’m assigned a new job while I’m offline?',
    a: 'No, notifications need a connection to arrive. You’ll see any new assignment the moment your phone reconnects — it’s not lost, just delayed until then.',
  },
  {
    q: 'I sent a message with no signal — did it go through?',
    a: 'It’s saved and waiting. A message you send with no signal shows a clock icon and “Sending when you have signal”, and it goes out on its own the moment you’re back in range — you don’t need to retype or resend it. If it ever genuinely can’t be delivered it moves to the red “didn’t sync” panel at the top of the screen. Older messages in the conversation only load when you have a connection, so the thread above may look empty while you’re offline.',
  },
  {
    q: 'I just got to a property with no signal and a screen won’t load / shows an error page — what happened?',
    a: 'Each screen needs to load once while you have signal before it’s available offline. If you head straight to a dead zone without opening the app first, a page you haven’t visited yet on that device may not load. Open the app and tap into your assignments while you still have service — at the office, in the driveway, wherever — before you lose signal for the day.',
  },
  {
    q: 'Will taking a lot of photos while offline fill up my phone’s storage?',
    a: 'The app automatically resizes and compresses every photo before saving it, so a full day of checklist and asset photos takes up far less space than the originals would. You don’t need to manage this yourself.',
  },
]
