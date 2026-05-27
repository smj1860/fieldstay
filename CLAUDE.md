# CLAUDE.md — FieldStay: Visual Redesign (Dark Theme + Ops Snapshot)

Read every section before writing any code. This is a large session —
complete each step in order. Test the build locally after Steps 1–3
before proceeding.

---

## What We're Building

1. **Full dark theme** — deep navy canvas, card surfaces, gold accent
2. **Syne + DM Sans fonts** replacing Inter
3. **Collapsible sidebar** with hamburger drawer on mobile
4. **Top bar** with live clock and notification bell
5. **Ops Snapshot page** — the new homepage after login (3-day ops view)
6. **Light/dark toggle** in Settings
7. **All dashboard pages** updated to dark theme

---

## Step 1 — Fonts + Tailwind + CSS Variables

### 1a — tailwind.config.ts

Add dark surface tokens and font families. Keep all existing color tokens:

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#EEF1F7',
          100: '#D5DBE9',
          200: '#AAB7D4',
          300: '#7F93BE',
          400: '#546FA9',
          500: '#2A4B8D',
          600: '#1A3570',
          700: '#152C5C',
          800: '#102246',
          900: '#0B1830',
        },
        gold: {
          50:  '#FFFDE7',
          100: '#FFF8C2',
          200: '#FEF08A',
          300: '#FCD116',
          400: '#EAB800',
          500: '#CA9A00',
        },
        accent: {
          50:  '#F8F9FA',
          100: '#E9ECEF',
          200: '#DEE2E6',
          300: '#CED4DA',
          400: '#ADB5BD',
          500: '#6C757D',
          600: '#495057',
          700: '#343A40',
          800: '#1A1D20',
          900: '#0D0F11',
        },
        // Dark theme surface palette
        surface: {
          base:   '#0a1628',
          canvas: '#0e1e3e',
          card:   '#152b52',
          raised: '#1a3464',
        },
      },
      boxShadow: {
        'card':      '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.05)',
        'card-md':   '0 4px 6px -1px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'dark-card': '0 1px 4px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.3)',
        'dark-lg':   '0 8px 32px rgba(0,0,0,0.5)',
      },
      fontFamily: {
        display: ['var(--font-syne)', 'sans-serif'],
        sans:    ['var(--font-dm-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
```

### 1b — app/layout.tsx

Add Syne + DM Sans fonts and the theme initialization script (prevents
flash of wrong theme on load):

```tsx
import type { Metadata, Viewport } from 'next'
import { Syne, DM_Sans } from 'next/font/google'
import './globals.css'

const syne = Syne({
  subsets:  ['latin'],
  variable: '--font-syne',
  display:  'swap',
})

const dmSans = DM_Sans({
  subsets:  ['latin'],
  variable: '--font-dm-sans',
  display:  'swap',
})

export const metadata: Metadata = {
  title: {
    default:  'FieldStay',
    template: '%s — FieldStay',
  },
  description: 'STR operations platform for property managers.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  ),
}

export const viewport: Viewport = {
  width:      'device-width',
  initialScale: 1,
  themeColor: '#0a1628',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning
          className={`${syne.variable} ${dmSans.variable}`}>
      {/*
        Theme init script — runs before paint to avoid flash.
        Reads localStorage and applies .light class if needed.
        Dark is the default so we only act if user chose light.
      */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              if (localStorage.getItem('fs-theme') === 'light') {
                document.documentElement.classList.add('light');
              }
            } catch(e) {}
          })();
        ` }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

### 1c — app/globals.css

Replace the entire file with this dark-first theme. Light mode is applied
via the `.light` class on `<html>`. All component classes use CSS
variables so they respond to the theme automatically:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ── Dark theme (default) ────────────────────────────────────── */
:root {
  --bg-base:        #0a1628;
  --bg-canvas:      #0e1e3e;
  --bg-card:        #152b52;
  --bg-raised:      #1a3464;
  --bg-hover:       #1e3a72;

  --border:         rgba(255, 255, 255, 0.07);
  --border-strong:  rgba(255, 255, 255, 0.14);

  --text-primary:   #ffffff;
  --text-secondary: #a8bdd4;
  --text-muted:     #5a7499;
  --text-inverse:   #0a1628;

  --accent-gold:       #FCD116;
  --accent-gold-dim:   rgba(252, 209, 22, 0.12);
  --accent-green:      #2fd98c;
  --accent-green-dim:  rgba(47, 217, 140, 0.10);
  --accent-red:        #f05454;
  --accent-red-dim:    rgba(240, 84, 84, 0.12);
  --accent-amber:      #f59e0b;
  --accent-amber-dim:  rgba(245, 158, 11, 0.12);
  --accent-blue:       #4da6ff;
  --accent-blue-dim:   rgba(77, 166, 255, 0.10);

  --shadow-card: 0 1px 4px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.25);
  --shadow-lg:   0 8px 32px rgba(0,0,0,0.5);

  --radius:    8px;
  --radius-lg: 12px;
}

/* ── Light theme override ─────────────────────────────────────── */
:root.light {
  --bg-base:        #eef2f7;
  --bg-canvas:      #F8F9FA;
  --bg-card:        #ffffff;
  --bg-raised:      #f0f4f8;
  --bg-hover:       #e8eef5;

  --border:         rgba(0, 0, 0, 0.08);
  --border-strong:  rgba(0, 0, 0, 0.15);

  --text-primary:   #0a1628;
  --text-secondary: #3d5a80;
  --text-muted:     #8299b0;
  --text-inverse:   #ffffff;

  --accent-gold:       #e8a325;
  --accent-gold-dim:   rgba(232, 163, 37, 0.12);
  --accent-green:      #16a34a;
  --accent-green-dim:  rgba(22, 163, 74, 0.10);
  --accent-red:        #dc2626;
  --accent-red-dim:    rgba(220, 38, 38, 0.10);
  --accent-amber:      #d97706;
  --accent-amber-dim:  rgba(217, 119, 6, 0.10);
  --accent-blue:       #2563eb;
  --accent-blue-dim:   rgba(37, 99, 235, 0.10);

  --shadow-card: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
  --shadow-lg:   0 8px 24px rgba(0,0,0,0.12);
}

/* ── Base ─────────────────────────────────────────────────────── */
@layer base {
  * { box-sizing: border-box; }

  html { height: 100%; }

  body {
    font-family: var(--font-dm-sans), ui-sans-serif, system-ui, sans-serif;
    background:  var(--bg-base);
    color:       var(--text-primary);
    font-size:   14px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Scrollbar */
  ::-webkit-scrollbar       { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background:    var(--border-strong);
    border-radius: 99px;
  }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
}

/* ── Components ───────────────────────────────────────────────── */
@layer components {

  /* ── Card ── */
  .card {
    background:    var(--bg-card);
    border-radius: var(--radius-lg);
    box-shadow:    var(--shadow-card);
    border:        1px solid var(--border);
    padding:       24px;
  }

  /* ── KPI / Stat card ── */
  .kpi-card {
    background:    var(--bg-card);
    border-radius: var(--radius-lg);
    box-shadow:    var(--shadow-card);
    border:        1px solid var(--border);
    padding:       20px;
    position:      relative;
    overflow:      hidden;
  }

  .kpi-card::before {
    content:  '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--kpi-accent, var(--accent-gold));
  }

  .kpi-value {
    font-family:     var(--font-syne), sans-serif;
    font-size:       28px;
    font-weight:     700;
    color:           var(--text-primary);
    letter-spacing:  -0.03em;
    line-height:     1;
    font-variant-numeric: tabular-nums;
  }

  .kpi-label {
    font-size:      11px;
    font-weight:    500;
    color:          var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.09em;
  }

  /* ── Section header ── */
  .section-header {
    font-size:      11px;
    font-weight:    600;
    color:          var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.09em;
    margin-bottom:  12px;
  }

  /* ── Page shell ── */
  .page-header { margin-bottom: 28px; }

  .page-title {
    font-family:    var(--font-syne), sans-serif;
    font-size:      22px;
    font-weight:    700;
    color:          var(--text-primary);
    letter-spacing: -0.02em;
  }

  .page-subtitle {
    font-size: 13px;
    color:     var(--text-muted);
    margin-top: 2px;
  }

  /* ── Badges ── */
  .badge {
    @apply inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full
           text-xs font-semibold;
  }

  .badge-green  { background: var(--accent-green-dim); color: var(--accent-green); }
  .badge-amber  { background: var(--accent-amber-dim); color: var(--accent-amber); }
  .badge-red    { background: var(--accent-red-dim);   color: var(--accent-red);   }
  .badge-blue   { background: var(--accent-blue-dim);  color: var(--accent-blue);  }
  .badge-gold   { background: var(--accent-gold-dim);  color: var(--accent-gold);  }
  .badge-slate  {
    background: var(--border);
    color:      var(--text-secondary);
  }

  /* ── Buttons ── */
  .btn {
    @apply inline-flex items-center justify-center gap-2 px-4 py-2
           rounded-lg text-sm font-medium transition-all duration-150
           disabled:opacity-50 disabled:cursor-not-allowed
           focus:outline-none focus:ring-2 focus:ring-offset-1;
    focus-ring-offset-color: var(--bg-canvas);
  }

  .btn-primary {
    @apply btn;
    background: #102246;
    color:      var(--text-primary);
    border:     1px solid var(--border-strong);
  }
  .btn-primary:hover { background: #1a3464; }

  .btn-cta {
    @apply btn;
    background: var(--accent-gold);
    color:      #0a1628;
    font-weight: 700;
  }
  .btn-cta:hover { filter: brightness(1.08); }

  .btn-secondary {
    @apply btn;
    background: var(--bg-raised);
    color:      var(--text-secondary);
    border:     1px solid var(--border);
  }
  .btn-secondary:hover {
    background: var(--bg-hover);
    color:      var(--text-primary);
  }

  .btn-danger {
    @apply btn;
    background: var(--accent-red-dim);
    color:      var(--accent-red);
    border:     1px solid rgba(240,84,84,0.2);
  }
  .btn-danger:hover { background: var(--accent-red); color: white; }

  .btn-ghost {
    @apply btn;
    background: transparent;
    color:      var(--text-muted);
  }
  .btn-ghost:hover {
    background: var(--border);
    color:      var(--text-primary);
  }

  /* ── Form inputs ── */
  .input {
    @apply w-full px-3 py-2 rounded-lg text-sm transition-all;
    background: var(--bg-raised);
    border:     1px solid var(--border);
    color:      var(--text-primary);
  }
  .input::placeholder { color: var(--text-muted); }
  .input:focus {
    outline:      none;
    border-color: var(--accent-gold);
    box-shadow:   0 0 0 2px var(--accent-gold-dim);
  }

  select.input option {
    background: var(--bg-raised);
    color:      var(--text-primary);
  }

  .label {
    display:       block;
    font-size:     12px;
    font-weight:   500;
    color:         var(--text-secondary);
    margin-bottom: 6px;
    letter-spacing: 0.02em;
  }
}
```

---

## Step 2 — Collapsible Sidebar + Top Bar (Layout Overhaul)

The current layout is a server component. Extract the sidebar and topbar
into client components to support the collapse state and live clock.

### 2a — New file: `components/dashboard-shell.tsx`

This is the client wrapper for the entire dashboard chrome (sidebar +
topbar). The server layout renders it with the data it needs.

```tsx
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Building2, CalendarCheck, Package,
  Wrench, Mail, BarChart3, Settings, ChevronLeft,
  ChevronRight, Menu, X, Bell, Sun, Moon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MemberRole } from '@/types/database'

const NAV_ITEMS = [
  { href: '/ops',            label: 'Ops Snapshot', icon: LayoutDashboard, roles: ['admin','manager','viewer'] },
  { href: '/properties',    label: 'Properties',   icon: Building2,       roles: ['admin','manager','viewer'] },
  { href: '/turnovers',     label: 'Turnovers',    icon: CalendarCheck,   roles: ['admin','manager','viewer'] },
  { href: '/inventory',     label: 'Inventory',    icon: Package,         roles: ['admin','manager']          },
  { href: '/maintenance',   label: 'Maintenance',  icon: Wrench,          roles: ['admin','manager']          },
  { href: '/communications',label: 'Comms',        icon: Mail,            roles: ['admin','manager']          },
  { href: '/owners',        label: 'Owner Portal', icon: BarChart3,       roles: ['admin','manager']          },
  { href: '/settings',      label: 'Settings',     icon: Settings,        roles: ['admin']                    },
] as const

interface Props {
  role:      MemberRole
  orgName:   string
  userEmail: string
  children:  React.ReactNode
}

export function DashboardShell({ role, orgName, userEmail, children }: Props) {
  const pathname   = usePathname()
  const [collapsed, setCollapsed]   = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [theme, setTheme]           = useState<'dark' | 'light'>('dark')
  const [time, setTime]             = useState('')

  // Live clock
  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', {
        hour:   'numeric',
        minute: '2-digit',
        hour12: true,
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

  const filteredNav = NAV_ITEMS.filter((item) =>
    item.roles.includes(role as never)
  )

  const Sidebar = ({ mobile = false }: { mobile?: boolean }) => (
    <aside
      className={cn(
        'flex flex-col h-full transition-all duration-300',
        mobile ? 'w-64' : collapsed ? 'w-[68px]' : 'w-60'
      )}
      style={{
        background:  'var(--bg-base)',
        borderRight: '1px solid var(--border)',
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-3 px-4 py-5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)', minHeight: 72 }}
      >
        {/* Logo mark */}
        <div
          className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center
                     justify-center font-black text-sm"
          style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
        >
          FS
        </div>
        {(!collapsed || mobile) && (
          <div className="min-w-0">
            <span className="font-display font-bold text-base leading-none"
                  style={{ color: 'var(--text-primary)' }}>
              FieldStay
            </span>
            <p className="text-xs truncate mt-0.5"
               style={{ color: 'var(--text-muted)' }}>
              {orgName}
            </p>
          </div>
        )}
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
        {filteredNav.map((item) => {
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
                'font-medium transition-all relative',
                active
                  ? 'text-white'
                  : 'hover:text-white'
              )}
              style={{
                background: active ? 'var(--bg-raised)' : 'transparent',
                color:      active ? 'var(--text-primary)' : 'var(--text-muted)',
                borderLeft: active
                  ? '2px solid var(--accent-gold)'
                  : '2px solid transparent',
              }}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {(!collapsed || mobile) && (
                <span className="truncate">{item.label}</span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Bottom user row */}
      <div
        className="p-3 flex-shrink-0"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-2.5 px-2 py-2 rounded-lg transition-all',
          )}
          style={{ color: 'var(--text-muted)' }}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
          onMouseOut={(e)  => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          <span
            className="w-7 h-7 rounded-full flex-shrink-0 flex items-center
                       justify-center text-xs font-bold"
            style={{
              background: 'var(--accent-gold-dim)',
              color:      'var(--accent-gold)',
            }}
          >
            {userEmail[0]?.toUpperCase() ?? '?'}
          </span>
          {(!collapsed || mobile) && (
            <span className="truncate text-xs">{userEmail}</span>
          )}
        </Link>
      </div>
    </aside>
  )

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
          <button
            onClick={() => setMobileOpen(false)}
            className="absolute top-4 right-4 z-20 p-2 rounded-lg"
            style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Top bar */}
        <header
          className="h-[60px] flex items-center justify-between
                     px-5 flex-shrink-0"
          style={{
            background:   'var(--bg-base)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {/* Left: hamburger (mobile) + collapse (desktop) */}
          <div className="flex items-center gap-3">
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-2 rounded-lg transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Desktop collapse toggle */}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="hidden md:flex p-2 rounded-lg transition-all"
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

          {/* Right: clock + theme toggle + notifications */}
          <div className="flex items-center gap-2">
            {/* Live clock */}
            {time && (
              <span
                className="hidden sm:block text-xs font-medium mr-2"
                style={{
                  color:          'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing:  '0.04em',
                }}
              >
                {time}
              </span>
            )}

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-lg flex items-center justify-center
                         transition-all"
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

            {/* Notification bell (placeholder — wire up later) */}
            <button
              className="w-8 h-8 rounded-lg flex items-center justify-center
                         transition-all relative"
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
              <Bell className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main
          className="flex-1 overflow-y-auto"
          style={{ background: 'var(--bg-canvas)' }}
        >
          <div className="max-w-7xl mx-auto px-6 py-7">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
```

### 2b — Update `app/(dashboard)/layout.tsx`

Replace the layout body with the new DashboardShell:

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard-shell'
import { ReviewPrompt } from '@/components/review-prompt'

const MILESTONE_MESSAGES: Record<string, string> = {
  first_ical_sync:            'Your first bookings are syncing.',
  first_turnover_complete:    'First turnover done — FieldStay is working.',
  first_purchase_order:       'FieldStay just caught a restock before you ran out.',
  first_owner_portal_view:    'Your owner just viewed their P&L.',
  second_property_configured: "You're managing multiple properties with FieldStay.",
  turnover_milestone_10:      '10 turnovers coordinated through FieldStay.',
  turnover_milestone_50:      "50 turnovers. That's serious volume.",
  thirty_days:                "You've been running operations with FieldStay for a month.",
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id, role, organizations(name, plan, plan_status, max_properties)')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) redirect('/onboarding')

  const org = Array.isArray(membership.organizations)
    ? membership.organizations[0]
    : membership.organizations

  // Milestone prompt
  const { data: pendingMilestone } = await supabase
    .from('org_milestones')
    .select('milestone, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('dismissed', false)
    .is('prompted_at', null)
    .order('achieved_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (pendingMilestone) {
    await supabase
      .from('org_milestones')
      .update({ prompted_at: new Date().toISOString() })
      .eq('org_id', membership.org_id)
      .eq('milestone', pendingMilestone.milestone)
  }

  return (
    <DashboardShell
      role={membership.role}
      orgName={org?.name ?? 'FieldStay'}
      userEmail={user.email ?? ''}
    >
      {pendingMilestone && MILESTONE_MESSAGES[pendingMilestone.milestone] && (
        <ReviewPrompt
          milestone={pendingMilestone.milestone}
          message={MILESTONE_MESSAGES[pendingMilestone.milestone]!}
          orgId={membership.org_id}
        />
      )}
      {children}
    </DashboardShell>
  )
}
```

### 2c — Delete `app/(dashboard)/dashboard-nav.tsx`

This file is now replaced by the nav inside `DashboardShell`.

---

## Step 3 — Update Redirects

Every post-login redirect currently goes to `/properties`. Change them
all to `/ops` (the new Ops Snapshot home).

**Files to update:**

`middleware.ts` — line 27:
```ts
url.pathname = '/ops'
```

`app/auth/callback/route.ts` — default `next` parameter:
```ts
const next = searchParams.get('next') ?? '/ops'
```

`app/onboarding/actions.ts` — final redirect:
```ts
redirect('/ops')
```

`app/(auth)/signup/signup-form.tsx` — any hardcoded `/properties` redirect.

---

## Step 4 — Ops Snapshot Page

### 4a — New file: `app/(dashboard)/ops/page.tsx`

```tsx
import { requireOrgMember } from '@/lib/auth'
import { OpsSnapshot } from './ops-snapshot'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Ops Snapshot' }

export default async function OpsSnapshotPage() {
  const { supabase, membership } = await requireOrgMember()

  const now       = new Date()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1)

  const fmt = (d: Date) => d.toISOString().split('T')[0]

  const [
    { data: turnovers },
    { data: properties },
    { data: openWOs },
    { data: lowStockItems },
    { data: crewMembers },
  ] = await Promise.all([
    // Turnovers for yesterday, today, tomorrow
    supabase
      .from('turnovers')
      .select(`
        id, property_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes,
        turnover_assignments (
          id,
          crew_members ( id, name )
        )
      `)
      .eq('org_id', membership.org_id)
      .neq('status', 'cancelled')
      .gte('checkout_datetime', fmt(yesterday) + 'T00:00:00')
      .lte('checkout_datetime', fmt(tomorrow)  + 'T23:59:59')
      .order('checkout_datetime'),

    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),

    // Open work orders
    supabase
      .from('work_orders')
      .select('id, title, property_id, priority, status, scheduled_date')
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'assigned', 'in_progress'])
      .order('scheduled_date', { ascending: true })
      .limit(8),

    // Items below par
    supabase
      .from('inventory_items')
      .select('id, name, property_id, current_quantity, par_level')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .filter('current_quantity', 'lte', 'par_level'),

    supabase
      .from('crew_members')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),
  ])

  // Build KPI counts
  const todayStr = fmt(now)
  const todayTurnovers = (turnovers ?? []).filter((t) =>
    t.checkout_datetime.startsWith(todayStr)
  )
  const unassignedCount = (turnovers ?? []).filter((t) => {
    const assignments = Array.isArray(t.turnover_assignments)
      ? t.turnover_assignments
      : t.turnover_assignments ? [t.turnover_assignments] : []
    return assignments.length === 0 && t.status !== 'completed'
  }).length

  return (
    <OpsSnapshot
      turnovers={turnovers ?? []}
      properties={properties ?? []}
      openWorkOrders={openWOs ?? []}
      lowStockItems={lowStockItems ?? []}
      kpis={{
        turnoversToday: todayTurnovers.length,
        unassigned:     unassignedCount,
        openWorkOrders: openWOs?.length ?? 0,
        belowPar:       lowStockItems?.length ?? 0,
      }}
      dates={{
        yesterday: fmt(yesterday),
        today:     fmt(now),
        tomorrow:  fmt(tomorrow),
      }}
    />
  )
}
```

### 4b — New file: `app/(dashboard)/ops/ops-snapshot.tsx`

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  CalendarCheck, Clock, User, AlertTriangle,
  Wrench, Package, ChevronRight,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────

interface TurnoverAssignment {
  id:           string
  crew_members: { id: string; name: string } | { id: string; name: string }[] | null
}

interface Turnover {
  id:                   string
  property_id:          string
  checkout_datetime:    string
  checkin_datetime:     string
  window_minutes:       number | null
  status:               string
  priority:             string
  notes:                string | null
  turnover_assignments: TurnoverAssignment | TurnoverAssignment[] | null
}

interface Property { id: string; name: string; city: string | null; state: string | null }
interface WorkOrder { id: string; title: string; property_id: string; priority: string; status: string; scheduled_date: string | null }
interface LowStockItem { id: string; name: string; property_id: string; current_quantity: number; par_level: number }

interface KPIs {
  turnoversToday: number
  unassigned:     number
  openWorkOrders: number
  belowPar:       number
}

// ── KPI Card ───────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  accentColor = 'var(--accent-gold)',
  alert = false,
}: {
  label:        string
  value:        number
  accentColor?: string
  alert?:       boolean
}) {
  return (
    <div
      className="kpi-card"
      style={{ '--kpi-accent': accentColor } as React.CSSProperties}
    >
      <div className="kpi-value" style={alert && value > 0
        ? { color: accentColor }
        : undefined
      }>
        {value}
      </div>
      <div className="kpi-label mt-2">{label}</div>
    </div>
  )
}

// ── Turnover Card ──────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending_assignment: 'var(--text-muted)',
  assigned:           'var(--accent-blue)',
  in_progress:        '#a78bfa',
  completed:          'var(--accent-green)',
  flagged:            'var(--accent-red)',
}

function TurnoverCard({
  turnover,
  propertyName,
}: {
  turnover:     Turnover
  propertyName: string
}) {
  const assignments = Array.isArray(turnover.turnover_assignments)
    ? turnover.turnover_assignments
    : turnover.turnover_assignments
      ? [turnover.turnover_assignments]
      : []

  const crew = assignments.flatMap((a) => {
    const cm = a.crew_members
    return cm ? (Array.isArray(cm) ? cm : [cm]) : []
  })

  const statusColor = STATUS_COLORS[turnover.status] ?? 'var(--text-muted)'
  const isUrgent    = turnover.priority === 'urgent' || turnover.priority === 'high'
  const checkout    = new Date(turnover.checkout_datetime)

  return (
    <Link href={`/turnovers/${turnover.id}`}>
      <div
        className="rounded-xl p-4 mb-2.5 transition-all cursor-pointer"
        style={{
          background:  'var(--bg-card)',
          border:      `1px solid var(--border)`,
          borderLeft:  isUrgent
            ? `3px solid var(--accent-amber)`
            : `3px solid ${statusColor}`,
        }}
        onMouseOver={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-raised)'
        }}
        onMouseOut={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'
        }}
      >
        {/* Property name */}
        <p className="font-semibold text-sm mb-1.5 truncate"
           style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-syne)' }}>
          {propertyName}
        </p>

        {/* Time */}
        <div className="flex items-center gap-1.5 text-xs mb-2"
             style={{ color: 'var(--text-muted)' }}>
          <Clock className="w-3 h-3 flex-shrink-0" />
          <span>
            {checkout.toLocaleTimeString('en-US', {
              hour:   'numeric',
              minute: '2-digit',
            })}
          </span>
          {turnover.window_minutes && (
            <>
              <span>·</span>
              <span>{Math.floor(turnover.window_minutes / 60)}h window</span>
            </>
          )}
        </div>

        {/* Crew / status row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            <User className="w-3 h-3 flex-shrink-0"
                  style={{ color: 'var(--text-muted)' }} />
            <span style={{
              color: crew.length > 0 ? 'var(--text-secondary)' : 'var(--accent-amber)',
              fontWeight: crew.length === 0 ? 600 : 400,
            }}>
              {crew.length > 0
                ? crew.map((c) => c.name).join(', ')
                : 'Unassigned'
              }
            </span>
          </div>

          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{
              background: `${statusColor}20`,
              color:      statusColor,
            }}
          >
            {turnover.status.replace('_', ' ')}
          </span>
        </div>
      </div>
    </Link>
  )
}

// ── Day Column ─────────────────────────────────────────────────

function DayColumn({
  label,
  isToday,
  turnovers,
  propertyMap,
}: {
  label:       string
  isToday:     boolean
  turnovers:   Turnover[]
  propertyMap: Record<string, string>
}) {
  return (
    <div className="flex flex-col min-w-0">
      {/* Column header */}
      <div
        className="flex items-center justify-between px-4 py-3 rounded-xl mb-3"
        style={{
          background: isToday ? 'var(--bg-raised)' : 'var(--border)',
          border:     isToday
            ? `1px solid var(--accent-gold)`
            : '1px solid transparent',
        }}
      >
        <span
          className="font-display font-bold text-sm"
          style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
        >
          {label}
        </span>
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full"
          style={{
            background: isToday
              ? 'var(--accent-gold-dim)'
              : 'var(--border)',
            color: isToday
              ? 'var(--accent-gold)'
              : 'var(--text-muted)',
          }}
        >
          {turnovers.length}
        </span>
      </div>

      {/* Turnover cards */}
      <div className="flex-1">
        {turnovers.length === 0 ? (
          <div
            className="rounded-xl p-6 text-center text-sm"
            style={{
              background: 'var(--bg-card)',
              border:     '1px solid var(--border)',
              color:      'var(--text-muted)',
            }}
          >
            No turnovers
          </div>
        ) : (
          turnovers.map((t) => (
            <TurnoverCard
              key={t.id}
              turnover={t}
              propertyName={propertyMap[t.property_id] ?? 'Unknown property'}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────

export function OpsSnapshot({
  turnovers,
  properties,
  openWorkOrders,
  lowStockItems,
  kpis,
  dates,
}: {
  turnovers:      Turnover[]
  properties:     Property[]
  openWorkOrders: WorkOrder[]
  lowStockItems:  LowStockItem[]
  kpis:           KPIs
  dates:          { yesterday: string; today: string; tomorrow: string }
}) {
  const [mobileDay, setMobileDay] = useState<'yesterday' | 'today' | 'tomorrow'>('today')

  const propertyMap = Object.fromEntries(
    properties.map((p) => [p.id, p.name])
  )

  const byDay = {
    yesterday: turnovers.filter((t) => t.checkout_datetime.startsWith(dates.yesterday)),
    today:     turnovers.filter((t) => t.checkout_datetime.startsWith(dates.today)),
    tomorrow:  turnovers.filter((t) => t.checkout_datetime.startsWith(dates.tomorrow)),
  }

  const dayLabels = {
    yesterday: 'Yesterday',
    today:     'Today',
    tomorrow:  'Tomorrow',
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Ops Snapshot</h1>
          <p className="page-subtitle">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric'
            })}
          </p>
        </div>
        <Link href="/turnovers" className="btn-secondary text-xs gap-1.5">
          Full board <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <KpiCard
          label="Turnovers Today"
          value={kpis.turnoversToday}
          accentColor="var(--accent-gold)"
        />
        <KpiCard
          label="Unassigned"
          value={kpis.unassigned}
          accentColor="var(--accent-amber)"
          alert
        />
        <KpiCard
          label="Open Work Orders"
          value={kpis.openWorkOrders}
          accentColor="var(--accent-blue)"
          alert
        />
        <KpiCard
          label="Below Par"
          value={kpis.belowPar}
          accentColor="var(--accent-red)"
          alert
        />
      </div>

      {/* Desktop: 3-column layout */}
      <div className="hidden md:grid grid-cols-3 gap-5">
        {(['yesterday', 'today', 'tomorrow'] as const).map((day) => (
          <DayColumn
            key={day}
            label={dayLabels[day]}
            isToday={day === 'today'}
            turnovers={byDay[day]}
            propertyMap={propertyMap}
          />
        ))}
      </div>

      {/* Mobile: tab switcher + single column */}
      <div className="md:hidden">
        {/* Day tabs */}
        <div
          className="flex rounded-xl p-1 mb-4 gap-1"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          {(['yesterday', 'today', 'tomorrow'] as const).map((day) => (
            <button
              key={day}
              onClick={() => setMobileDay(day)}
              className="flex-1 py-2 rounded-lg text-sm font-semibold
                         transition-all"
              style={{
                background: mobileDay === day
                  ? 'var(--bg-raised)'
                  : 'transparent',
                color: mobileDay === day
                  ? 'var(--accent-gold)'
                  : 'var(--text-muted)',
                border: mobileDay === day
                  ? '1px solid var(--border-strong)'
                  : '1px solid transparent',
              }}
            >
              {dayLabels[day]}
              <span className="ml-1.5 text-xs opacity-70">
                ({byDay[day].length})
              </span>
            </button>
          ))}
        </div>

        <DayColumn
          label={dayLabels[mobileDay]}
          isToday={mobileDay === 'today'}
          turnovers={byDay[mobileDay]}
          propertyMap={propertyMap}
        />
      </div>

      {/* Bottom panels: Work orders + Low stock */}
      {(openWorkOrders.length > 0 || lowStockItems.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-8">

          {/* Open work orders */}
          {openWorkOrders.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="section-header mb-0">Open Work Orders</p>
                <Link href="/maintenance"
                      className="text-xs"
                      style={{ color: 'var(--accent-gold)' }}>
                  View all →
                </Link>
              </div>
              <div
                className="rounded-xl overflow-hidden"
                style={{ border: '1px solid var(--border)' }}
              >
                {openWorkOrders.slice(0, 5).map((wo, i) => (
                  <Link key={wo.id} href={`/maintenance/${wo.id}`}>
                    <div
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 transition-colors',
                        i > 0 && 'border-t'
                      )}
                      style={{
                        background:  'var(--bg-card)',
                        borderColor: 'var(--border)',
                      }}
                      onMouseOver={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          'var(--bg-raised)'
                      }}
                      onMouseOut={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          'var(--bg-card)'
                      }}
                    >
                      <Wrench className="w-4 h-4 flex-shrink-0"
                              style={{ color: 'var(--accent-blue)' }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate"
                           style={{ color: 'var(--text-primary)' }}>
                          {wo.title}
                        </p>
                        <p className="text-xs"
                           style={{ color: 'var(--text-muted)' }}>
                          {propertyMap[wo.property_id] ?? ''}
                        </p>
                      </div>
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium
                                   flex-shrink-0"
                        style={{
                          background: wo.priority === 'urgent' || wo.priority === 'high'
                            ? 'var(--accent-red-dim)'
                            : 'var(--accent-amber-dim)',
                          color: wo.priority === 'urgent' || wo.priority === 'high'
                            ? 'var(--accent-red)'
                            : 'var(--accent-amber)',
                        }}
                      >
                        {wo.priority}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Below par items */}
          {lowStockItems.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="section-header mb-0">Below Par</p>
                <Link href="/inventory"
                      className="text-xs"
                      style={{ color: 'var(--accent-gold)' }}>
                  View all →
                </Link>
              </div>
              <div
                className="rounded-xl overflow-hidden"
                style={{ border: '1px solid var(--border)' }}
              >
                {lowStockItems.slice(0, 5).map((item, i) => (
                  <div
                    key={item.id}
                    className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t')}
                    style={{
                      background:  'var(--bg-card)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    <Package className="w-4 h-4 flex-shrink-0"
                             style={{ color: 'var(--accent-red)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate"
                         style={{ color: 'var(--text-primary)' }}>
                        {item.name}
                      </p>
                      <p className="text-xs"
                         style={{ color: 'var(--text-muted)' }}>
                        {propertyMap[item.property_id] ?? ''}
                      </p>
                    </div>
                    <span
                      className="text-xs font-semibold"
                      style={{ color: 'var(--accent-red)' }}
                    >
                      {item.current_quantity}/{item.par_level}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

---

## Step 5 — Inventory RLS Grant for Below-Par Filter

The Ops Snapshot queries inventory items with `current_quantity <= par_level`.
PostgreSQL can't compare two columns in a Supabase filter this way via the
client SDK. Use a raw filter instead:

In `app/(dashboard)/ops/page.tsx`, replace the inventory query with:

```ts
supabase
  .from('inventory_items')
  .select('id, name, property_id, current_quantity, par_level')
  .eq('org_id', membership.org_id)
  .eq('is_active', true)
  .lte('low_stock_threshold_pct', 100)  // fetch all, filter client-side
  .limit(50),
```

Then filter client-side before passing to the component:
```ts
const actualLowStock = (inventoryItems ?? []).filter(
  (i) => i.current_quantity <= i.par_level
)
```

Pass `actualLowStock` as `lowStockItems`.

---

## Step 6 — Page-Level Dark Theme Updates

All existing dashboard pages use classes like `.card`, `.btn-primary`,
`.input`, `.badge-*`, `.page-title` etc. Since those classes now use CSS
variables, they automatically pick up the dark theme.

However, any page that has hardcoded Tailwind color classes
(`bg-white`, `text-accent-900`, `border-accent-200`, `bg-accent-50`) needs
those replaced with CSS variable equivalents. Do a global search and replace:

| Old class | Replace with inline style or CSS var class |
|-----------|-------------------------------------------|
| `bg-white` | `style={{ background: 'var(--bg-card)' }}` |
| `bg-accent-50` | `style={{ background: 'var(--bg-canvas)' }}` |
| `text-accent-900` | `style={{ color: 'var(--text-primary)' }}` |
| `text-accent-700` | `style={{ color: 'var(--text-secondary)' }}` |
| `text-accent-500` | `style={{ color: 'var(--text-muted)' }}` |
| `border-accent-200` | `style={{ borderColor: 'var(--border)' }}` |
| `bg-accent-100` | `style={{ background: 'var(--border)' }}` |
| `divide-accent-100` | Remove and add `borderTop: '1px solid var(--border)'` per row |

Focus on these files first (highest user visibility):
- `app/(dashboard)/turnovers/turnover-board.tsx`
- `app/(dashboard)/properties/page.tsx`
- `app/(dashboard)/inventory/inventory-manager.tsx`
- `app/(dashboard)/maintenance/maintenance-board.tsx`
- `app/(dashboard)/owners/owners-manager.tsx`
- `app/(dashboard)/settings/settings-tabs.tsx`

---

## Step 7 — Remove Old dashboard-nav.tsx Import

Search the codebase for any remaining imports of `DashboardNav` or
`dashboard-nav` and remove them. The nav is now inside `DashboardShell`.

---

## Verification Checklist

- [ ] `npm run build` passes with no errors
- [ ] Dark theme renders — canvas is deep navy, cards are lighter navy,
      gold accent on nav active state and KPI bars
- [ ] Syne font appears on page titles and KPI numbers
      (verify in browser DevTools: computed font-family)
- [ ] Sidebar collapses to icon-only on desktop (click chevron)
- [ ] Mobile: hamburger opens drawer, clicking a nav link closes it
- [ ] Top bar shows live clock updating every second
- [ ] Theme toggle (sun/moon icon) switches between dark and light
- [ ] Light mode: white cards, navy text, readable
- [ ] Theme persists after page refresh (localStorage working)
- [ ] After login → lands on `/ops` (Ops Snapshot), not `/properties`
- [ ] Ops Snapshot shows KPI cards with correct counts
- [ ] 3 day columns show correct turnovers per day
- [ ] Below-par items and open WOs appear in bottom panels
- [ ] Mobile: tab switcher shows one day at a time
- [ ] All existing pages (turnovers, inventory, etc.) render correctly
      in dark theme — no white boxes, no invisible text

---

## Notes

- Do NOT change the `app/page.tsx` landing page — it uses its own
  inline styles and should stay as-is
- The auth pages (`/login`, `/signup`, `/onboarding`) use the brand
  navy background which works in both themes — leave them alone
- The crew app at `/crew` has its own shell — leave it alone
- The owner portal and vendor portal are standalone tokenized pages —
  leave them alone
