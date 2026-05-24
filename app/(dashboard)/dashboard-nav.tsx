'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2,
  CalendarCheck,
  Package,
  Wrench,
  Mail,
  BarChart3,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MemberRole } from '@/types/database'

const NAV_ITEMS = [
  { href: '/properties',     label: 'Properties',     icon: Building2,    roles: ['admin','manager','viewer'] },
  { href: '/turnovers',      label: 'Turnovers',      icon: CalendarCheck, roles: ['admin','manager','viewer'] },
  { href: '/inventory',      label: 'Inventory',      icon: Package,      roles: ['admin','manager'] },
  { href: '/maintenance',    label: 'Maintenance',    icon: Wrench,       roles: ['admin','manager'] },
  { href: '/communications', label: 'Communications', icon: Mail,         roles: ['admin','manager'] },
  { href: '/owners',         label: 'Owner Portal',   icon: BarChart3,    roles: ['admin','manager'] },
  { href: '/settings',       label: 'Settings',       icon: Settings,     roles: ['admin'] },
] as const

export function DashboardNav({ role }: { role: MemberRole }) {
  const pathname = usePathname()

  return (
    <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
      {NAV_ITEMS.filter((item) => item.roles.includes(role as never)).map((item) => {
        const Icon    = item.icon
        const active  = pathname === item.href || pathname.startsWith(item.href + '/')

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
              active
                ? 'bg-brand-700 text-white'
                : 'text-brand-200 hover:bg-brand-700/50 hover:text-white'
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
