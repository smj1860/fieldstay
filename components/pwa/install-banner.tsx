'use client'

import { useState, useEffect, useSyncExternalStore } from 'react'
import { Download, Share2, X } from 'lucide-react'

// Chrome/Android deferred install prompt — not yet in standard TypeScript DOM lib
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type BannerState = 'hidden' | 'android' | 'ios'

const DISMISS_KEY    = 'pwa-install-dismissed-at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function checkRecentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    return Date.now() - parseInt(raw, 10) < DISMISS_TTL_MS
  } catch {
    return false
  }
}

function saveDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

function isIOSSafari(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent
  return /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios/i.test(ua)
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).standalone === true
  )
}

// Only knowable client-side, and only ever needs to be read once at mount —
// useSyncExternalStore gives the SSR render a safe default ('hidden') and
// the client's first render already reflects the real value.
function initialBannerState(): BannerState {
  if (isStandalone()) return 'hidden'
  if (checkRecentlyDismissed()) return 'hidden'
  if (isIOSSafari()) return 'ios'
  return 'hidden' // resolved to 'android' later, only if the browser fires beforeinstallprompt
}
const noopSubscribe = () => () => {}

export function InstallBanner() {
  const initialState = useSyncExternalStore(noopSubscribe, initialBannerState, () => 'hidden' as BannerState)
  const [state, setState]               = useState<BannerState>(initialState)
  const [prompt, setPrompt]             = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    // Already installed as PWA, or the user dismissed recently — never show
    if (isStandalone()) return
    if (checkRecentlyDismissed()) return

    // iOS never fires beforeinstallprompt — already resolved via initialBannerState()
    if (isIOSSafari()) return

    const handler = (e: Event) => {
      e.preventDefault()
      setPrompt(e as BeforeInstallPromptEvent)
      setState('android')
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  function dismiss() {
    saveDismissed()
    setState('hidden')
  }

  async function install() {
    if (!prompt) return
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    setPrompt(null)
    if (outcome === 'accepted') {
      setState('hidden')
    } else {
      dismiss()
    }
  }

  if (state === 'hidden') return null

  if (state === 'ios') {
    return (
      <div
        className="mx-4 mt-2 rounded-xl p-4 flex gap-3"
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
      >
        <Share2
          className="w-5 h-5 shrink-0 mt-0.5"
          style={{ color: 'var(--accent-gold)' }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Add to Home Screen
          </p>
          <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Tap <Share2 className="inline w-3 h-3 mx-0.5" style={{ verticalAlign: '-1px' }} /> then
            &ldquo;Add to Home Screen&rdquo; for the best experience.
          </p>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="shrink-0 -mt-1 -mr-1 p-1 rounded-lg transition-opacity active:opacity-60"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    )
  }

  // Android / Chrome
  return (
    <div
      className="mx-4 mt-2 rounded-xl p-4 flex items-center gap-3"
      style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
    >
      <Download
        className="w-5 h-5 shrink-0"
        style={{ color: 'var(--accent-gold)' }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Install FieldStay
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Add to your home screen for faster access.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="p-1 rounded-lg transition-opacity active:opacity-60"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>
        <button
          onClick={install}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity active:opacity-80"
          style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
        >
          Install
        </button>
      </div>
    </div>
  )
}
