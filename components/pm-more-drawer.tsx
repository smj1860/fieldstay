'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X } from 'lucide-react'
import type { MemberRole } from '@/types/database'
import { getVisibleNavItems, type NavItem } from '@/lib/navigation'

const CLUSTER_ORDER = ['Portfolio', 'Team & Vendors', 'Guest & Comms'] as const

interface PmMoreDrawerProps {
  open:    boolean
  onClose: () => void
  role:    MemberRole
  repuguardActive?: boolean
}

export function PmMoreDrawer({ open, onClose, role, repuguardActive = false }: PmMoreDrawerProps) {
  const pathname = usePathname()

  // Ops Snapshot, Turnovers, Inventory, and Maintenance are persistent tabs
  // in BottomNav already — everything else management-tier, plus Bookings
  // (the one ops-tier item with no persistent tab of its own), shows up
  // here. help/support-inbox aren't reachable from mobile today, so they
  // stay excluded.
  const items = getVisibleNavItems(role, { repuguardActive }).filter(
    (item) => (item.tier === 'management' || item.id === 'bookings') &&
      item.id !== 'help' && item.id !== 'support-inbox'
  )

  if (!open) return null

  const renderItem = (item: NavItem) => {
    const Icon   = item.icon
    const active = pathname === item.href || pathname.startsWith(item.href + '/')
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClose}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all"
        style={{
          background: active ? 'var(--bg-raised)' : 'transparent',
          color:      active ? 'var(--text-primary)' : 'var(--text-muted)',
          borderLeft: active ? '2px solid var(--accent-gold)' : '2px solid transparent',
        }}
      >
        <Icon className="w-5 h-5 flex-shrink-0" />
        <span>{item.label}</span>
      </Link>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close drawer"
        className="fixed inset-0 z-40 md:hidden w-full cursor-default"
        style={{ background: 'rgba(0,0,0,0.5)', border: 'none', padding: 0 }}
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

        {/* Nav items — Bookings and Settings stay flat (same as today);
            the three management categories get a header each, always
            expanded — this is a bottom sheet opened on demand, not
            something sitting permanently on screen, so headers alone
            solve scanability without an extra tap-to-expand. */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {items.filter((item) => item.id === 'bookings').map(renderItem)}

          {CLUSTER_ORDER.map((category) => {
            const clusterItems = items.filter((item) => item.category === category)
            if (clusterItems.length === 0) return null
            return (
              <div key={category}>
                <span
                  className="block px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide first:pt-1"
                  style={{ color: 'var(--text-muted)', opacity: 0.6 }}
                >
                  {category}
                </span>
                {clusterItems.map(renderItem)}
              </div>
            )
          })}

          {items.filter((item) => item.category === 'Settings').map(renderItem)}
        </div>
      </div>
    </>
  )
}
