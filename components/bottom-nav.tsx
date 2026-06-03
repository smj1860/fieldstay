'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, CalendarCheck, Package,
  Wrench, MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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

export function BottomNav({ role, onMore }: BottomNavProps) {
  const pathname = usePathname()
  const effectiveRole = role === 'owner' ? 'admin' : role
  const items = BOTTOM_NAV_ITEMS.filter(item =>
    (item.roles as readonly string[]).includes(effectiveRole)
  )

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex md:hidden"
      style={{
        background:   'var(--bg-base)',
        borderTop:    '1px solid var(--border)',
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
            className="flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-xs font-medium transition-colors"
            style={{ color: active ? 'var(--accent-gold)' : 'var(--text-muted)' }}
          >
            <Icon className="w-5 h-5" />
            <span>{item.label}</span>
          </Link>
        )
      })}
      <button
        onClick={onMore}
        className="flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-xs font-medium transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <MoreHorizontal className="w-5 h-5" />
        <span>More</span>
      </button>
    </nav>
  )
}
