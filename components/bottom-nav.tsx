'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, CalendarCheck, Package,
  Wrench, MoreHorizontal,
} from 'lucide-react'
import type { MemberRole } from '@/types/database'

const BOTTOM_NAV_ITEMS = [
  { href: '/ops',          label: 'Overview',   icon: LayoutDashboard, roles: ['admin','manager','viewer'] },
  { href: '/turnovers',    label: 'Turnovers',  icon: CalendarCheck,   roles: ['admin','manager','viewer'] },
  { href: '/inventory',    label: 'Inventory',  icon: Package,         roles: ['admin','manager']          },
  { href: '/maintenance',  label: 'Maintenance',icon: Wrench,          roles: ['admin','manager']          },
] as const

interface BottomNavProps {
  role: MemberRole
  onMore: () => void
}

export function BottomNav({ role, onMore }: Readonly<BottomNavProps>) {
  const pathname = usePathname()
  const effectiveRole = role === 'owner' ? 'admin' : role
  const items = BOTTOM_NAV_ITEMS.filter(item =>
    (item.roles as readonly string[]).includes(effectiveRole)
  )

  const moreActive = !items.some(item =>
    pathname === item.href || pathname.startsWith(item.href + '/')
  )

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex md:hidden"
      style={{
        background:   'var(--chrome-bg)',
        borderTop:    '1px solid var(--chrome-border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {items.map(item => {
        const Icon   = item.icon
        const active = pathname === item.href || pathname.startsWith(item.href + '/')
        return (
          <Link
            key={item.href}
            href={item.href}
            className="relative flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-xs font-medium transition-colors"
            style={{ color: active ? 'var(--chrome-gold)' : 'var(--chrome-text-muted)' }}
          >
            {active && (
              <span
                className="absolute inset-x-2 top-1 bottom-1 rounded-xl"
                style={{ background: 'var(--chrome-gold-dim)' }}
              />
            )}
            <Icon className="relative z-10 w-5 h-5" />
            <span className="relative z-10">{item.label}</span>
          </Link>
        )
      })}
      <button
        onClick={onMore}
        className="relative flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-xs font-medium transition-colors"
        style={{ color: moreActive ? 'var(--chrome-gold)' : 'var(--chrome-text-muted)' }}
      >
        {moreActive && (
          <span
            className="absolute inset-x-2 top-1 bottom-1 rounded-xl"
            style={{ background: 'var(--chrome-gold-dim)' }}
          />
        )}
        <MoreHorizontal className="relative z-10 w-5 h-5" />
        <span className="relative z-10">Menu</span>
      </button>
    </nav>
  )
}
