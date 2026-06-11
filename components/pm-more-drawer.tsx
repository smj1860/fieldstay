'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  X, Building2, ShieldCheck, TrendingUp, Users2,
  Briefcase, Mail, BarChart3, Settings, Star, CalendarCheck,
} from 'lucide-react'
import type { MemberRole } from '@/types/database'

const MORE_ITEMS = [
  { href: '/bookings',        label: 'Bookings',        icon: CalendarCheck, roles: ['admin','manager','viewer'] },
  { href: '/properties',      label: 'Properties',      icon: Building2,     roles: ['admin','manager','viewer'] },
  { href: '/assets',          label: 'Asset Health',    icon: ShieldCheck,   roles: ['admin','manager']          },
  { href: '/capital-planning',label: 'Capital Planning',icon: TrendingUp,    roles: ['admin','manager']          },
  { href: '/crew-manage',     label: 'Crew',            icon: Users2,        roles: ['admin','manager']          },
  { href: '/vendors',         label: 'Vendors',         icon: Briefcase,     roles: ['admin','manager']          },
  { href: '/comms-log',       label: 'Comms Log',       icon: Mail,          roles: ['admin','manager']          },
  { href: '/owners',          label: 'Owner Portal',    icon: BarChart3,     roles: ['admin','manager']          },
  { href: '/reviews',         label: 'Reviews',         icon: Star,          roles: ['admin','manager']          },
  { href: '/settings',        label: 'Settings',        icon: Settings,      roles: ['admin']                    },
] as const

interface PmMoreDrawerProps {
  open:    boolean
  onClose: () => void
  role:    MemberRole
  repuguardActive?: boolean
}

export function PmMoreDrawer({ open, onClose, role, repuguardActive = false }: PmMoreDrawerProps) {
  const pathname      = usePathname()
  const effectiveRole = role === 'owner' ? 'admin' : role

  const items = MORE_ITEMS.filter((item) => {
    if (item.href === '/reviews' && !repuguardActive) return false
    return (item.roles as readonly string[]).includes(effectiveRole)
  })

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 md:hidden"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 md:hidden rounded-t-2xl"
        style={{
          background:   'var(--bg-card)',
          border:       '1px solid var(--border)',
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)',
          maxHeight:    '75vh',
          overflowY:    'auto',
        }}
      >
        {/* Handle + header */}
        <div className="relative flex items-center justify-between px-5 pt-4 pb-3">
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full"
            style={{ background: 'var(--border-strong)' }}
          />
          <p className="text-sm font-semibold mt-2" style={{ color: 'var(--text-primary)' }}>
            More
          </p>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav items grid */}
        <div className="grid grid-cols-3 gap-2 px-4 py-2">
          {items.map((item) => {
            const Icon   = item.icon
            const active = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className="flex flex-col items-center gap-2 py-4 rounded-xl transition-all"
                style={{
                  background: active ? 'var(--accent-gold-dim)' : 'var(--bg-raised)',
                  color:      active ? 'var(--accent-gold)'     : 'var(--text-secondary)',
                }}
              >
                <Icon className="w-5 h-5" />
                <span className="text-xs font-medium text-center leading-tight">{item.label}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </>
  )
}
