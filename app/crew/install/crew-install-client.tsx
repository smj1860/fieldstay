'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Share, Plus, Check, AlertTriangle, Home } from 'lucide-react'
import { Button } from '@/components/ui/Button'

// ── Types ─────────────────────────────────────────────────────────────────────

type Platform = 'ios' | 'android' | 'desktop' | 'unknown'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/iphone|ipad|ipod/i.test(ua))       return 'ios'
  if (/android/i.test(ua))                return 'android'
  if (/macintosh|windows|linux/i.test(ua)) return 'desktop'
  return 'unknown'
}

function isRunningAsPWA(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (
      'standalone' in window.navigator &&
      (window.navigator as { standalone?: boolean }).standalone === true
    )
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function IOSInstructions() {
  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        Add to Home Screen (iOS Safari)
      </p>
      <ol className="space-y-3">
        {([
          { icon: Share, text: 'Tap the Share button at the bottom of Safari' },
          { icon: Plus,  text: 'Scroll down and tap "Add to Home Screen"' },
          { icon: Check, text: 'Tap "Add" in the top-right corner' },
        ] as const).map(({ icon: Icon, text }, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className="w-7 h-7 rounded-full font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
            >
              {i + 1}
            </span>
            <p className="text-sm flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
              <Icon className="w-4 h-4 flex-shrink-0" />{text}
            </p>
          </li>
        ))}
      </ol>
      <div
        className="rounded-xl px-3 py-2.5 text-xs flex items-start gap-1.5"
        style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }}
      >
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>Must be opened in <strong>Safari</strong> — Chrome on iOS does not
        support home screen install.</span>
      </div>
    </div>
  )
}

function AndroidInstructions() {
  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        Add to Home Screen (Android Chrome)
      </p>
      <ol className="space-y-3">
        {([
          { icon: null, text: 'Tap the menu icon (⋮) in Chrome\'s top-right corner' },
          { icon: Plus,  text: 'Tap "Add to Home screen"' },
          { icon: Check, text: 'Tap "Add" to confirm' },
        ] as const).map(({ icon: Icon, text }, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className="w-7 h-7 rounded-full font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
            >
              {i + 1}
            </span>
            <p className="text-sm flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
              {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}{text}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

function DesktopInstructions() {
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        FieldStay Crew is designed for mobile. Open this link on your phone to
        install the app on your home screen.
      </p>
      <div
        className="rounded-xl px-4 py-3 text-sm font-mono break-all select-all"
        style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)' }}
      >
        app.fieldstay.app/crew
      </div>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Tap and hold the URL above to copy it, then open it on your phone.
      </p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const noopSubscribe = () => () => {}

export function CrewInstallClient() {
  const router = useRouter()

  // Platform/PWA state is only knowable client-side — read via
  // useSyncExternalStore so the SSR render gets a safe default and the
  // client's first render already reflects the real value, no extra effect
  // + setState render needed.
  const platform = useSyncExternalStore(noopSubscribe, detectPlatform, () => 'unknown' as Platform)
  const alreadyPWA = useSyncExternalStore(noopSubscribe, isRunningAsPWA, () => false)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)

  // If already running as an installed PWA, skip the install page entirely
  useEffect(() => {
    if (alreadyPWA) router.replace('/crew')
  }, [alreadyPWA, router])

  // Capture the Chrome/Android native install prompt if available
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleAndroidNativeInstall = async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') router.replace('/crew')
  }

  const handleSkip = () => router.replace('/crew')

  // Don't render until we know the platform (avoids flash of wrong instructions)
  if (alreadyPWA || platform === 'unknown') return null

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="w-full max-w-sm">

        {/* Header */}
        <div className="text-center mb-8">
          <div
            className="w-20 h-20 rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-lg"
            style={{ background: 'var(--bg-card)' }}
          >
            {/* App icon placeholder — replace with <Image> pointing to /icon-192.png */}
            <Home className="w-9 h-9" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Account Active
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Install the app to access your assignments
          </p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl shadow-lg p-6 space-y-5"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          {/* Android — native browser prompt available */}
          {platform === 'android' && deferredPrompt && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Install FieldStay on your home screen for one-tap access to your
                work orders and assignments.
              </p>
              <Button
                variant="cta"
                onClick={handleAndroidNativeInstall}
                className="w-full py-3"
              >
                Install App →
              </Button>
            </div>
          )}

          {/* Android — Chrome but no deferred prompt (already dismissed, or not Chrome) */}
          {platform === 'android' && !deferredPrompt && <AndroidInstructions />}

          {/* iOS */}
          {platform === 'ios' && <IOSInstructions />}

          {/* Desktop */}
          {platform === 'desktop' && <DesktopInstructions />}

          {/* Skip link — always visible */}
          <button
            type="button"
            onClick={handleSkip}
            className="w-full text-center text-sm transition-colors py-3"
            style={{ color: 'var(--text-muted)' }}
          >
            Skip for now — open in browser
          </button>
        </div>

      </div>
    </div>
  )
}
