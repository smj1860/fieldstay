'use client'

import { useEffect, type RefObject } from 'react'

// Focus trap + Escape-to-close + body-scroll lock for a modal-like panel.
// Shared by components/ui/Dialog.tsx, components/pm-more-drawer.tsx, and
// DashboardShell's mobile sidebar drawer, which previously each carried a
// byte-for-byte identical copy of this effect.
export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  open:     boolean,
  onClose:  () => void,
) {
  useEffect(() => {
    if (!open) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const panel = panelRef.current
    const focusable = panel?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.[0]?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !focusable || focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalOverflow
      previouslyFocused?.focus()
    }
  }, [open, onClose, panelRef])
}
