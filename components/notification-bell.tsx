'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import type { NotificationItem } from '@/lib/notifications'

export function NotificationBell({ items }: { items: NotificationItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

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
        {items.length > 0 && (
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
              {items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-raised)]"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <span
                    className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                    style={{ background: item.severity === 'red' ? 'var(--accent-red)' : 'var(--accent-amber)' }}
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
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
