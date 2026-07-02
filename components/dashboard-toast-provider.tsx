'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'

interface ToastItem {
  id:       string
  title:    string
  subtitle: string
  href:     string
  severity: 'amber' | 'red'
}

const ToastContext = createContext<{ push: (t: Omit<ToastItem, 'id'>) => void } | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within DashboardToastProvider')
  return ctx
}

export function DashboardToastProvider({
  orgId,
  userId,
  children,
}: Readonly<{
  orgId:    string
  userId:   string
  children: React.ReactNode
}>) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { ...t, id }])
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000)
  }, [])

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    const channel = supabase
      .channel(`dashboard-alerts-${orgId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `recipient_id=eq.${userId}`,
      }, (payload) => {
        push({
          title:    'New message',
          subtitle: String(payload.new.content).slice(0, 80),
          href:     '/messages',
          severity: 'amber',
        })
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'turnovers',
        filter: `org_id=eq.${orgId}`,
      }, (payload) => {
        if (payload.new.status === 'flagged' && payload.old.status !== 'flagged') {
          push({
            title:    'Turnover flagged',
            subtitle: 'A crew member flagged an issue',
            href:     `/turnovers/${payload.new.id}`,
            severity: 'red',
          })
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [orgId, userId, push])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <a
            key={t.id}
            href={t.href}
            className="rounded-xl px-4 py-3 shadow-card-lg flex items-start gap-3 transition-transform hover:scale-[1.02]"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <span
              className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
              style={{ background: t.severity === 'red' ? 'var(--accent-red)' : 'var(--accent-amber)' }}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t.title}</p>
              <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{t.subtitle}</p>
            </div>
          </a>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
