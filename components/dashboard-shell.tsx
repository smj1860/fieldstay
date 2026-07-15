'use client'

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ChevronLeft, ChevronRight, ChevronDown, Menu, X, Sun, Moon,
  LifeBuoy, Bell, Inbox, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MemberRole } from '@/types/database'
import type { NotificationItem } from '@/lib/notifications'
import { BottomNav } from '@/components/bottom-nav'
import { PmMoreDrawer } from '@/components/pm-more-drawer'
import { CommandPalette } from '@/components/command-palette'
import { NotificationBell } from '@/components/notification-bell'
import { SidebarUserMenu } from '@/components/layout/SidebarUserMenu'
import { InstallBanner } from '@/components/pwa/install-banner'
import { useTheme } from '@/lib/hooks/use-theme'
import { useFocusTrap } from '@/lib/hooks/use-focus-trap'
import { getVisibleNavItems, type NavItem } from '@/lib/navigation'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
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

const PAGE_TITLES: Record<string, string> = {
  '/ops':          'Ops Snapshot',
  '/properties':   'Properties',
  '/bookings':     'Bookings',
  '/turnovers':    'Turnovers',
  '/inventory':    'Inventory',
  '/maintenance':  'Maintenance',
  '/assets':            'Assets',
  '/capital-planning':  'Capital Planning',
  '/crew-manage':  'Crew',
  '/messages':     'Messages',
  '/vendors':      'Vendors',
  '/comms-log':    'Comms Log',
  '/owners':       'Owner Portal',
  '/guidebook':    'Guidebook',
  '/reviews':      'Reviews',
  '/settings':     'Settings',
  '/help':             'Help & Support',
  '/support-inbox':    'Support Inbox',
}

interface Props {
  role:                       MemberRole
  orgName:                    string
  userName:                   string
  userEmail:                  string
  repuguardActive?:           boolean
  onboardingComplete?:        boolean
  onboardingPct?:             number
  notifications?:             NotificationItem[]
  unreadMessages?:            number
  isStaff?:                   boolean
  children:                   React.ReactNode
}

const CLUSTER_STORAGE_KEY = 'fs-nav-clusters'
const CLUSTER_ORDER = ['Portfolio', 'Team & Vendors', 'Guest & Comms'] as const

// Same useSyncExternalStore + module-level-listeners pattern as
// lib/hooks/use-theme.ts — the correct way to sync a localStorage-backed
// preference into render without a hydration mismatch (React uses
// getServerSnapshot during SSR and the initial client render, then swaps to
// the real client snapshot post-hydration) or an effect+setState cascade.
const clusterListeners = new Set<() => void>()
let clusterSnapshot: Record<string, boolean> = readClusterStateFromStorage()

function readClusterStateFromStorage(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(CLUSTER_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function getClusterSnapshot(): Record<string, boolean> {
  return clusterSnapshot
}

function getClusterServerSnapshot(): Record<string, boolean> {
  return {}
}

function subscribeToClusters(onChange: () => void): () => void {
  clusterListeners.add(onChange)
  return () => clusterListeners.delete(onChange)
}

function writeClusterState(next: Record<string, boolean>) {
  clusterSnapshot = next
  try {
    window.localStorage.setItem(CLUSTER_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable — collapse preference just won't persist
  }
  clusterListeners.forEach((l) => l())
}

interface DashboardSidebarProps {
  mobile?:             boolean
  pathname:            string
  collapsed:           boolean
  onCloseMobile:       () => void
  unreadMessages:      number
  onboardingComplete:  boolean
  onboardingPct:       number
  opsNav:              NavItem[]
  mgmtNav:             NavItem[]
  isStaff:             boolean
  orgName:             string
  userName:            string
  userEmail:           string
}

// Hoisted to a top-level component rather than defined inline inside
// DashboardShell's render body — an inline component gets a brand-new
// component type on every render of the parent, which forces React to
// unmount and remount the entire sidebar (losing any internal state,
// re-running effects) instead of just updating it. DashboardShell renders
// on every route change, so this ran on every single navigation.
function DashboardSidebar({
  mobile = false,
  pathname,
  collapsed,
  onCloseMobile,
  unreadMessages,
  onboardingComplete,
  onboardingPct,
  opsNav,
  mgmtNav,
  isStaff,
  orgName,
  userName,
  userEmail,
}: Readonly<DashboardSidebarProps>) {
  // getServerSnapshot ({}) covers SSR and the initial client render so
  // there's no hydration mismatch; useSyncExternalStore swaps to the real
  // localStorage-backed snapshot right after. isClusterExpanded's `?? true`
  // fallback keeps everything expanded until then, which is also the
  // correct default for a first-ever visit.
  const expandedClusters = useSyncExternalStore(
    subscribeToClusters, getClusterSnapshot, getClusterServerSnapshot
  )

  function isClusterExpanded(category: string): boolean {
    const hasActiveItem = mgmtNav.some(
      (item) => item.category === category && (pathname === item.href || pathname.startsWith(item.href + '/'))
    )
    if (hasActiveItem) return true
    return expandedClusters[category] ?? true
  }

  function toggleCluster(category: string) {
    const next = { ...expandedClusters, [category]: !isClusterExpanded(category) }
    writeClusterState(next)
  }

  const renderNavLink = (item: NavItem) => {
    const Icon   = item.icon
    const active = pathname === item.href ||
                   pathname.startsWith(item.href + '/')

    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onCloseMobile}
        title={collapsed && !mobile ? item.label : undefined}
        className={cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm',
          'font-medium transition-all relative',
          'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]',
          !active && 'hover:text-[var(--chrome-text)] focus-visible:text-[var(--chrome-text)]'
        )}
        style={{
          background: active ? 'var(--chrome-bg-raised)' : 'transparent',
          color:      active ? 'var(--chrome-text)' : 'var(--chrome-text-muted)',
          borderLeft: active ? '2px solid var(--chrome-gold)' : '2px solid transparent',
        }}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        {(!collapsed || mobile) && (
          <>
            <span className="truncate">{item.label}</span>
            {item.href === '/messages' && unreadMessages > 0 && (
              <span
                className="ml-auto text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"
                style={{ background: '#FCD116', color: '#0a1628' }}
              >
                {unreadMessages > 99 ? '99+' : unreadMessages}
              </span>
            )}
          </>
        )}
      </Link>
    )
  }

  return (
    <aside
      className={cn(
        'flex flex-col h-full transition-all duration-300',
        mobile ? 'w-[min(256px,85vw)]' : collapsed ? 'w-[68px]' : 'w-60'
      )}
      style={{
        background:  'var(--chrome-bg)',
        borderRight: '1px solid var(--chrome-border)',
      }}
    >
      {/* Logo row — close button lives here on mobile */}
      <div
        className="flex items-center gap-3 px-4 py-5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--chrome-border)', minHeight: 72 }}
      >
        <div
          className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center
                     justify-center font-black text-sm"
          style={{ background: 'var(--chrome-gold)', color: 'var(--chrome-bg)' }}
        >
          FS
        </div>
        {(!collapsed || mobile) && (
          <div className="min-w-0 flex-1">
            <span className="font-display font-bold text-base leading-none"
                  style={{ color: 'var(--chrome-text)' }}>
              FieldStay
            </span>
            <p className="text-xs truncate mt-0.5"
               style={{ color: 'var(--chrome-text-muted)' }}>
              {orgName}
            </p>
          </div>
        )}
        {mobile && (
          <button
            onClick={onCloseMobile}
            className="ml-auto p-2 rounded-lg flex-shrink-0"
            style={{ color: 'var(--chrome-text-muted)' }}
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
        {!onboardingComplete && (!collapsed || mobile) && (
          <Link
            href="/setup"
            onClick={onCloseMobile}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all mb-2"
            style={{
              background: 'var(--chrome-gold-dim)',
              color:      'var(--chrome-gold)',
              border:     '1px solid rgba(252,209,22,0.2)',
            }}
          >
            <Zap className="w-4 h-4" />
            <span>Complete Setup</span>
            <span className="ml-auto text-xs opacity-70">{onboardingPct}%</span>
          </Link>
        )}
        {opsNav.map(renderNavLink)}

        {mgmtNav.length > 0 && (
          <>
            <div className="mt-3 mb-1 pt-2" style={{ borderTop: '1px solid var(--chrome-border)' }}>
              {(!collapsed || mobile) && (
                <span
                  className="block px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--chrome-text-muted)', opacity: 0.7 }}
                >
                  Management
                </span>
              )}
            </div>
            {collapsed && !mobile ? (
              mgmtNav.map(renderNavLink)
            ) : (
              <>
                {CLUSTER_ORDER.map((category) => {
                  const clusterItems = mgmtNav.filter((item) => item.category === category)
                  if (clusterItems.length === 0) return null
                  const expanded = mobile ? true : isClusterExpanded(category)

                  return (
                    <div key={category} className="mb-0.5">
                      {mobile ? (
                        <span
                          className="block px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: 'var(--chrome-text-muted)', opacity: 0.6 }}
                        >
                          {category}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleCluster(category)}
                          aria-expanded={expanded}
                          className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px]
                                     font-semibold uppercase tracking-wide transition-colors
                                     hover:text-[var(--chrome-text)]
                                     focus:outline-none focus:ring-2 focus:ring-inset
                                     focus:ring-[var(--accent-gold)] rounded"
                          style={{ color: 'var(--chrome-text-muted)', opacity: 0.6 }}
                        >
                          {expanded
                            ? <ChevronDown className="w-3 h-3 flex-shrink-0" />
                            : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                          {category}
                        </button>
                      )}
                      {expanded && clusterItems.map(renderNavLink)}
                    </div>
                  )
                })}
                {mgmtNav.filter((item) => item.category === 'Settings').map(renderNavLink)}
              </>
            )}
          </>
        )}
      </nav>

      {/* ── Staff-only: Support Inbox ──────────────────── */}
      {isStaff && (
        <div className="px-2 pt-1 pb-0 flex-shrink-0" style={{ borderTop: '1px solid var(--chrome-border)' }}>
          <Link
            href="/support-inbox"
            onClick={onCloseMobile}
            title={collapsed && !mobile ? 'Support Inbox' : undefined}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all hover:bg-[var(--chrome-bg-raised)] hover:text-[var(--chrome-text)] focus-visible:bg-[var(--chrome-bg-raised)] focus-visible:text-[var(--chrome-text)]"
            style={{
              color:      pathname.startsWith('/support-inbox') ? 'var(--chrome-text)' : 'var(--chrome-text-muted)',
              background: pathname.startsWith('/support-inbox') ? 'var(--chrome-bg-raised)' : 'transparent',
              borderLeft: pathname.startsWith('/support-inbox') ? '2px solid var(--chrome-gold)' : '2px solid transparent',
            }}
          >
            <Inbox className="w-4 h-4 flex-shrink-0" />
            {(!collapsed || mobile) && <span className="truncate">Support Inbox</span>}
          </Link>
        </div>
      )}

      {/* ── Help & Support ─────────────────────────────── */}
      <div
        className="px-2 pt-1 pb-0 flex-shrink-0"
        style={{ borderTop: '1px solid var(--chrome-border)' }}
      >
        <Link
          href="/help"
          onClick={onCloseMobile}
          title={collapsed && !mobile ? 'Help & Support' : undefined}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all hover:bg-[var(--chrome-bg-raised)] hover:text-[var(--chrome-text)] focus-visible:bg-[var(--chrome-bg-raised)] focus-visible:text-[var(--chrome-text)]"
          style={{ color: 'var(--chrome-text-muted)' }}
        >
          <LifeBuoy className="w-4 h-4 flex-shrink-0" />
          {(!collapsed || mobile) && (
            <span className="truncate">Help &amp; Support</span>
          )}
        </Link>
      </div>

      {/* Bottom user row */}
      {(!collapsed || mobile) && (
        <div className="px-2 pb-3 pt-3 flex-shrink-0" style={{ borderTop: '1px solid var(--chrome-border)' }}>
          <SidebarUserMenu
            userName={userName}
            userEmail={userEmail}
            orgName={orgName}
          />
        </div>
      )}
    </aside>
  )
}

export function DashboardShell({ role, orgName, userName, userEmail, repuguardActive = false, onboardingComplete = true, onboardingPct = 0, notifications = [], unreadMessages = 0, isStaff = false, children }: Readonly<Props>) {
  const pathname   = usePathname()
  const [collapsed,  setCollapsed]  = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [moreDrawerOpen, setMoreDrawerOpen] = useState(false)
  const { theme, toggle: toggleTheme } = useTheme()
  const [time,       setTime]       = useState('')
  const [swReg,        setSwReg]        = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)
  const mobileDrawerRef = useRef<HTMLDivElement>(null)

  // Mobile sidebar drawer — focus trap, Escape-to-close, body-scroll lock.
  // Same shared hook as components/ui/Dialog.tsx and pm-more-drawer.tsx,
  // adapted to this component's existing mobileOpen/setMobileOpen state
  // rather than a generic open/onClose prop pair. closeMobileDrawer is
  // memoized with a stable identity (setMobileOpen itself never changes)
  // so the hook's effect re-fires only when mobileOpen changes, matching
  // this effect's original single-dependency `[mobileOpen]` array exactly.
  const closeMobileDrawer = useCallback(() => setMobileOpen(false), [])
  useFocusTrap(mobileDrawerRef, mobileOpen, closeMobileDrawer)

  // Live clock
  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Register service worker for dashboard push — no permission prompt on mount
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

  async function enableDashboardNotifications() {
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

  const visibleItems = getVisibleNavItems(role, { repuguardActive, isStaff })

  // Split into Ops (daily-use) and Management (weekly-use) tiers, rendered
  // as two groups with a divider to keep the sidebar scannable. help and
  // support-inbox are excluded — DashboardSidebar renders those as their
  // own hardcoded blocks below the scrollable nav list.
  const opsNav  = visibleItems.filter((item) => item.tier === 'ops')
  const mgmtNav = visibleItems.filter((item) =>
    item.tier === 'management' && item.id !== 'help' && item.id !== 'support-inbox'
  )

  // Derive page title for mobile header
  const pageTitle = Object.entries(PAGE_TITLES).find(([path]) =>
    pathname === path || pathname.startsWith(path + '/')
  )?.[1] ?? ''

  return (
    <div className="flex min-h-screen"
         style={{ background: 'var(--bg-base)' }}>

      {/* Desktop sidebar — pinned via sticky positioning while the page scrolls as one unit */}
      <div className="hidden md:flex flex-shrink-0 sticky top-0 h-screen">
        <DashboardSidebar
          pathname={pathname}
          collapsed={collapsed}
          onCloseMobile={() => setMobileOpen(false)}
          unreadMessages={unreadMessages}
          onboardingComplete={onboardingComplete}
          onboardingPct={onboardingPct}
          opsNav={opsNav}
          mgmtNav={mgmtNav}
          isStaff={isStaff}
          orgName={orgName}
          userName={userName}
          userEmail={userEmail}
        />
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            role="button"
            tabIndex={0}
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMobileOpen(false) } }}
          />
          <div ref={mobileDrawerRef} role="dialog" aria-modal="true" className="relative z-10 h-full flex-shrink-0">
            <DashboardSidebar
              mobile
              pathname={pathname}
              collapsed={collapsed}
              onCloseMobile={() => setMobileOpen(false)}
              unreadMessages={unreadMessages}
              onboardingComplete={onboardingComplete}
              onboardingPct={onboardingPct}
              opsNav={opsNav}
              mgmtNav={mgmtNav}
              isStaff={isStaff}
              orgName={orgName}
              userName={userName}
              userEmail={userEmail}
            />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* Top bar — pinned to the top of the viewport as the page scrolls */}
        <header
          className="h-[60px] relative flex items-center justify-between px-5 flex-shrink-0 sticky top-0 z-20"
          style={{
            background:   'var(--bg-card)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {/* Left: hamburger (mobile) + collapse (desktop) */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden w-11 h-11 flex items-center justify-center rounded-lg transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              <Menu className="w-5 h-5" />
            </button>

            <button
              onClick={() => setCollapsed(!collapsed)}
              className="hidden md:flex p-2.5 rounded-lg transition-all hover:bg-[var(--border)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--border)] focus-visible:text-[var(--text-primary)]"
              style={{ color: 'var(--text-muted)' }}
            >
              {collapsed
                ? <ChevronRight className="w-4 h-4" />
                : <ChevronLeft  className="w-4 h-4" />
              }
            </button>

            <CommandPalette role={role} repuguardActive={repuguardActive} isStaff={isStaff} />
          </div>

          {/* Mobile page title — centered absolutely */}
          {pageTitle && (
            <span
              className="md:hidden absolute left-1/2 -translate-x-1/2 text-sm font-semibold pointer-events-none"
              style={{ color: 'var(--text-primary)' }}
            >
              {pageTitle}
            </span>
          )}

          {/* Right: clock + theme toggle + notifications */}
          <div className="flex items-center gap-2">
            {time && (
              <span
                className="hidden sm:block text-xs font-medium mr-2"
                style={{
                  color:              'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing:      '0.04em',
                }}
              >
                {time}
              </span>
            )}

            <button
              onClick={toggleTheme}
              className="w-11 h-11 md:w-8 md:h-8 rounded-lg flex items-center justify-center transition-all hover:bg-[var(--border)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--border)] focus-visible:text-[var(--text-primary)]"
              style={{ color: 'var(--text-muted)' }}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark'
                ? <Sun  className="w-4 h-4" />
                : <Moon className="w-4 h-4" />
              }
            </button>

            {notifVisible && (
              <button
                onClick={enableDashboardNotifications}
                title="Enable push notifications"
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all relative hover:bg-[var(--border)] focus-visible:bg-[var(--border)]"
                style={{ color: 'var(--accent-amber, #f59e0b)' }}
              >
                <Bell className="w-4 h-4" />
                <span
                  className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--accent-amber, #f59e0b)' }}
                />
              </button>
            )}

            <NotificationBell items={notifications} />
          </div>
        </header>

        <InstallBanner />

        {/* Page content — no internal scroll region; the page itself
            (document/body) is the single scrollable surface */}
        <main
          className="flex-1"
          style={{ background: 'var(--bg-canvas)' }}
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-7 pb-24 md:pb-7">
            {children}
          </div>

          {/* Legal footer — always visible at the bottom of every PM page */}
          <div
            className="flex items-center justify-center gap-4 py-4 border-t"
            style={{ borderColor: 'var(--border)' }}
          >
            <a
              href="/privacy"
              className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
            >
              Privacy Policy
            </a>
            <span style={{ color: 'var(--border)' }}>·</span>
            <a
              href="/terms"
              className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
            >
              Terms of Service
            </a>
            <span style={{ color: 'var(--border)' }}>·</span>
            <a
              href="/dpa"
              className="text-xs hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
            >
              DPA
            </a>
          </div>
        </main>
      </div>

      {/* Bottom navigation (mobile only) */}
      <BottomNav role={role} onMore={() => setMoreDrawerOpen(true)} />

      {/* "More" drawer (mobile only) */}
      <PmMoreDrawer
        open={moreDrawerOpen}
        onClose={() => setMoreDrawerOpen(false)}
        role={role}
        repuguardActive={repuguardActive}
      />
    </div>
  )
}
