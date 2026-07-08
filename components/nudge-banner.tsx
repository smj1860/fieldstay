'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { X, Lightbulb } from 'lucide-react'

interface NudgeBannerProps {
  id:       string   // unique — used as localStorage dismiss key
  message:  string
  href:     string
  linkText: string
}

function notDismissed(id: string): boolean {
  try {
    const dismissed = JSON.parse(
      localStorage.getItem('fieldstay_dismissed_nudges') ?? '[]'
    ) as string[]
    return !dismissed.includes(id)
  } catch {
    return true
  }
}
const noopSubscribe = () => () => {}

export function NudgeBanner({ id, message, href, linkText }: NudgeBannerProps) {
  // Only the real value after mount (avoids SSR mismatch with localStorage)
  const notDismissedAtMount = useSyncExternalStore(noopSubscribe, () => notDismissed(id), () => false)
  const [dismissed, setDismissed] = useState(false)
  const visible = notDismissedAtMount && !dismissed

  const dismiss = () => {
    setDismissed(true)
    try {
      const dismissed = JSON.parse(
        localStorage.getItem('fieldstay_dismissed_nudges') ?? '[]'
      ) as string[]
      localStorage.setItem(
        'fieldstay_dismissed_nudges',
        JSON.stringify([...dismissed, id])
      )
    } catch {
      // localStorage unavailable — just hide
    }
  }

  if (!visible) return null

  return (
    <div
      className="flex items-start gap-3 rounded-xl px-4 py-3 mb-5"
      style={{
        background: 'var(--accent-gold-dim)',
        border:     '1px solid rgba(252,209,22,0.25)',
      }}
    >
      <Lightbulb
        className="w-4 h-4 flex-shrink-0 mt-0.5"
        style={{ color: 'var(--accent-gold)' }}
      />
      <p className="flex-1 text-sm leading-snug" style={{ color: 'var(--text-secondary)' }}>
        {message}{' '}
        <Link
          href={href}
          className="font-semibold underline-offset-2 underline"
          style={{ color: 'var(--accent-gold)' }}
        >
          {linkText} →
        </Link>
      </p>
      <button
        onClick={dismiss}
        className="flex-shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
        style={{ color: 'var(--text-muted)' }}
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
