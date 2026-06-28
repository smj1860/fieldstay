'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Building2, CalendarCheck, Package,
  Wrench, Mail, BarChart3, Settings, ChevronLeft,
  ChevronRight, Menu, X, Sun, Moon,
  Users2, Briefcase, MessageSquareDot, MessageSquare, ShieldCheck, TrendingUp,
  LifeBuoy, Bell, BookOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MemberRole } from '@/types/database'
import type { NotificationItem } from '@/lib/notifications'
import { BottomNav } from '@/components/bottom-nav'
import { PmMoreDrawer } from '@/components/pm-more-drawer'
import { NotificationBell } from '@/components/notification-bell'
import { SidebarUserMenu } from '@/components/layout/SidebarUserMenu'
import { InstallBanner } from '@/components/pwa/install-banner'

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

// Ops tier (daily use) first, then Management tier (weekly use) — split
// below into opsNav/mgmtNav and rendered as two groups with a divider.
const NAV_ITEMS = [
  { href: '/ops',          label: 'Ops Snapshot', icon: LayoutDashboard, roles: ['admin','manager','viewer'], group: 'ops' as const        },
  { href: '/bookings',    label: 'Bookings',      icon: CalendarCheck,   roles: ['admin','manager','viewer'], group: 'ops' as const        },
  { href: '/turnovers',   label: 'Turnovers',    icon: CalendarCheck,   roles: ['admin','manager','viewer'], group: 'ops' as const        },
  { href: '/maintenance', label: 'Maintenance',  icon: Wrench,          roles: ['admin','manager'],          group: 'ops' as const        },
  { href: '/inventory',   label: 'Inventory',    icon: Package,         roles: ['admin','manager'],          group: 'ops' as const        },
  { href: '/properties',  label: 'Properties',   icon: Building2,       roles: ['admin','manager','viewer'], group: 'management' as const },
  { href: '/assets',            label: 'Asset Health',     icon: ShieldCheck, roles: ['admin','manager'], group: 'management' as const },
  { href: '/capital-planning', label: 'Capital Planning', icon: TrendingUp,  roles: ['admin','manager'], group: 'management' as const },
  { href: '/crew-manage', label: 'Crew',         icon: Users2,          roles: ['admin','manager'],          group: 'management' as const },
  { href: '/messages', label: 'Messages', icon: MessageSquare, roles: ['admin','manager'], group: 'management' as const },
  { href: '/vendors',     label: 'Vendors',      icon: Briefcase,       roles: ['admin','manager'],          group: 'management' as const },
  { href: '/comms-log',   label: 'Comms Log',    icon: Mail,            roles: ['admin','manager'],          group: 'management' as const },
  { href: '/owners',      label: 'Owner Portal', icon: BarChart3,       roles: ['admin','manager'],          group: 'management' as const },
  { href: '/guidebook',   label: 'Guidebook',    icon: BookOpen,        roles: ['admin','manager'],          group: 'management' as const },
  { href: '/settings',    label: 'Settings',     icon: Settings,        roles: ['admin'],                    group: 'management' as const },
] as const

const PAGE_TITLES: Record<string, string> = {
  '/ops':          'Ops Snapshot',
  '/properties':   'Properties',
  '/bookings':     'Bookings',
  '/turnovers':    'Turnovers',
  '/inventory':    'Inventory',
  '/maintenance':  'Maintenance',
  '/assets':            'Asset Health',
  '/capital-planning':  'Capital Planning',
  '/crew-manage':  'Crew',
  '/messages':     'Messages',
  '/vendors':      'Vendors',
  '/comms-log':    'Comms Log',
  '/owners':       'Owner Portal',
  '/guidebook':    'Guidebook',
  '/reviews':      'Reviews',
  '/settings':     'Settings',
  '/help':         'Help & Support',
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
  children:                   React.ReactNode
}

export function DashboardShell({ role, orgName, userName, userEmail, repuguardActive = false, onboardingComplete = true, onboardingPct = 0, notifications = [], unreadMessages = 0, children }: Props) {
  const pathname   = usePathname()
  const [collapsed,  setCollapsed]  = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [moreDrawerOpen, setMoreDrawerOpen] = useState(false)
  const [theme,      setTheme]      = useState<'dark' | 'light'>('dark')
  const [time,       setTime]       = useState('')
  const [swReg,        setSwReg]        = useState<ServiceWorkerRegistration | null>(null)
  const [notifVisible, setNotifVisible] = useState(false)

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

  // Persist + apply theme
  useEffect(() => {
    try {
      const stored = localStorage.getItem('fs-theme') as 'dark' | 'light' | null
      if (stored) setTheme(stored)
    } catch {}
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

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try { localStorage.setItem('fs-theme', next) } catch {}
    if (next === 'light') {
      document.documentElement.classList.add('light')
    } else {
      document.documentElement.classList.remove('light')
    }
  }

  // Task 1: map 'owner' to 'admin' so owners see the full nav
  const effectiveRole = role === 'owner' ? 'admin' : role

  const REPUGUARD_NAV = repuguardActive
    ? [{ href: '/reviews', label: 'Reviews', icon: MessageSquareDot, roles: ['admin', 'manager'] as const, group: 'management' as const }]
    : []

  const baseNav   = NAV_ITEMS.filter((item) => item.roles.includes(effectiveRole as never))
  const reviewsNav = REPUGUARD_NAV.filter(item => item.roles.includes(effectiveRole as 'admin' | 'manager'))

  // Splice Reviews in directly after Properties rather than appending at the
  // end, so it sits where PMs expect it instead of trailing after Settings.
  const propertiesIdx = baseNav.findIndex((item) => item.href === '/properties')
  const filteredNav = propertiesIdx === -1
    ? [...baseNav, ...reviewsNav]
    : [...baseNav.slice(0, propertiesIdx + 1), ...reviewsNav, ...baseNav.slice(propertiesIdx + 1)]

  // Split into Ops (daily-use) and Management (weekly-use) tiers, rendered
  // as two groups with a divider to keep the sidebar scannable.
  const opsNav  = filteredNav.filter((item) => item.group === 'ops')
  const mgmtNav = filteredNav.filter((item) => item.group === 'management')

  // Derive page title for mobile header
  const pageTitle = Object.entries(PAGE_TITLES).find(([path]) =>
    pathname === path || pathname.startsWith(path + '/')
  )?.[1] ?? ''

  const Sidebar = ({ mobile = false }: { mobile?: boolean }) => {
    const renderNavLink = (item: typeof filteredNav[number]) => {
      const Icon   = item.icon
      const active = pathname === item.href ||
                     pathname.startsWith(item.href + '/')

      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMobileOpen(false)}
          title={collapsed && !mobile ? item.label : undefined}
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm',
            'font-medium transition-all relative'
          )}
          style={{
            background: active ? 'var(--chrome-bg-raised)' : 'transparent',
            color:      active ? 'var(--chrome-text)' : 'var(--chrome-text-muted)',
            borderLeft: active ? '2px solid var(--chrome-gold)' : '2px solid transparent',
          }}
          onMouseOver={(e) => {
            if (!active) e.currentTarget.style.color = 'var(--chrome-text)'
          }}
          onMouseOut={(e) => {
            if (!active) e.currentTarget.style.color = 'var(--chrome-text-muted)'
          }}
        >
          <Icon className="w-4 h-4 flex-shrink-0" />
          {(!collapsed || mobile) && (
            <>
              <span className="truncate">{item.label}</span>
              {item.href === '/messages' && (unreadMessages ?? 0) > 0 && (
                <span
                  className="ml-auto text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"
                  style={{ background: '#FCD116', color: '#0a1628' }}
                >
                  {(unreadMessages ?? 0) > 99 ? '99+' : unreadMessages}
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
            onClick={() => setMobileOpen(false)}
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
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all mb-2"
            style={{
              background: 'var(--chrome-gold-dim)',
              color:      'var(--chrome-gold)',
              border:     '1px solid rgba(252,209,22,0.2)',
            }}
          >
            <span>⚡</span>
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
            {mgmtNav.map(renderNavLink)}
          </>
        )}
      </nav>

      {/* ── Help & Support ─────────────────────────────── */}
      <div
        className="px-2 pt-1 pb-0 flex-shrink-0"
        style={{ borderTop: '1px solid var(--chrome-border)' }}
      >
        <Link
          href="/help"
          onClick={() => setMobileOpen(false)}
          title={collapsed && !mobile ? 'Help & Support' : undefined}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all"
          style={{ color: 'var(--chrome-text-muted)' }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = 'var(--chrome-bg-raised)'
            e.currentTarget.style.color = 'var(--chrome-text)'
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'var(--chrome-text-muted)'
          }}
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

  return (
    <div className="flex h-screen overflow-hidden"
         style={{ background: 'var(--bg-base)' }}>

      {/* Desktop sidebar */}
      <div className="hidden md:flex h-full flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 h-full flex-shrink-0">
            <Sidebar mobile />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Top bar */}
        <header
          className="h-[60px] relative flex items-center justify-between px-5 flex-shrink-0"
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
              className="hidden md:flex p-2.5 rounded-lg transition-all"
              style={{ color: 'var(--text-muted)' }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = 'var(--border)'
                e.currentTarget.style.color = 'var(--text-primary)'
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-muted)'
              }}
            >
              {collapsed
                ? <ChevronRight className="w-4 h-4" />
                : <ChevronLeft  className="w-4 h-4" />
              }
            </button>
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
              className="w-11 h-11 md:w-8 md:h-8 rounded-lg flex items-center justify-center transition-all"
              style={{ color: 'var(--text-muted)' }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = 'var(--border)'
                e.currentTarget.style.color = 'var(--text-primary)'
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-muted)'
              }}
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
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all relative"
                style={{ color: 'var(--accent-amber, #f59e0b)' }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'var(--border)' }}
                onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent' }}
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

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto"
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
