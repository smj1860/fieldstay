'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'

const STORAGE_KEY = 'fs-cookie-notice-dismissed'

function notDismissed(): boolean {
  try {
    return !localStorage.getItem(STORAGE_KEY)
  } catch {
    // localStorage unavailable (private mode, etc.) — don't show
    return false
  }
}
const noopSubscribe = () => () => {}

export function CookieNotice() {
  // Start hidden on server and first client paint — avoids hydration mismatch.
  // Revealed on mount only if the user hasn't dismissed before.
  const notDismissedAtMount = useSyncExternalStore(noopSubscribe, notDismissed, () => false)
  const [dismissed, setDismissed] = useState(false)
  const visible = notDismissedAtMount && !dismissed

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // ignore
    }
    setDismissed(true)
  }

  if (!visible) return null

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed bottom-0 left-0 right-0 z-50 p-4"
    >
      <div
        className="max-w-2xl mx-auto rounded-xl px-4 py-3 flex items-center gap-3 shadow-lg"
        style={{
          background: 'var(--bg-card)',
          border:     '1px solid var(--border)',
        }}
      >
        <p className="flex-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          We use essential cookies to keep you signed in and remember your preferences.
          No tracking or advertising cookies.{' '}
          <Link
            href="/privacy#cookies"
            className="underline underline-offset-2 hover:opacity-80"
            style={{ color: 'var(--text-primary)' }}
          >
            Privacy policy
          </Link>
        </p>
        <button
          onClick={dismiss}
          aria-label="Dismiss cookie notice"
          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity active:opacity-70"
          style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
        >
          Got it
        </button>
        <button
          onClick={dismiss}
          aria-label="Close"
          className="shrink-0 p-1 rounded transition-opacity active:opacity-70"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
