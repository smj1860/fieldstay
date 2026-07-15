'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import type { NotificationItem } from '@/lib/notifications'
import { markNotificationRead } from '@/app/(dashboard)/notifications-actions'

const SEVERITY_COLOR: Record<NotificationItem['severity'], string> = {
  red:   'var(--accent-red)',
  amber: 'var(--accent-amber)',
  green: 'var(--accent-green)',
  blue:  'var(--accent-blue)',
}

export function NotificationBell({ items }: Readonly<{ items: NotificationItem[] }>) {
  const [open, setOpen] = useState(false)
  // Local optimistic read-tracking so clicking doesn't wait on revalidation
  // to clear the badge dot.
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Unread = derived alerts (always "unread" — they have no read state) OR
  // a persisted item that isn't read yet and hasn't been optimistically
  // marked read in this session.
  const hasUnread = items.some(
    (item) => item.read === undefined || (!item.read && !readIds.has(item.id))
  )

  function handleItemClick(item: NotificationItem) {
    setOpen(false)
    if (item.read === false) {
      setReadIds((prev) => new Set(prev).add(item.id))
      markNotificationRead(item.id).catch(() => {
        // Non-fatal — worst case the dot reappears on next server fetch.
      })
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-11 h-11 md:w-8 md:h-8 rounded-lg flex items-center justify-center transition-all relative hover:bg-[var(--border)]"
        style={{ color: open ? 'var(--text-primary)' : 'var(--text-muted)' }}
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {hasUnread && (
          <span
            className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
            style={{ background: 'var(--accent-red)' }}
          />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] rounded-xl overflow-hidden z-50 shadow-card-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Notifications
            </span>
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              You&apos;re all caught up.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {items.map((item) => {
                const isRead = item.read === true || readIds.has(item.id)
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={() => handleItemClick(item)}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-raised)]"
                    style={{
                      borderBottom: '1px solid var(--border)',
                      opacity: isRead ? 0.6 : 1,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                      style={{ background: isRead ? 'var(--text-muted)' : SEVERITY_COLOR[item.severity] }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {item.title}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {item.subtitle}
                      </p>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
