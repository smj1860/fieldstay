'use client'

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// Focus trap + Escape-to-close + body-scroll lock for a modal-like panel.
// Shared by components/ui/Dialog.tsx, components/pm-more-drawer.tsx, and
// DashboardShell's mobile sidebar drawer, which previously each carried a
// byte-for-byte identical copy of this effect.
export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  open:     boolean,
  onClose:  () => void,
) {
  // `onClose` is held in a ref and deliberately kept OUT of the dep array.
  //
  // Callers overwhelmingly pass an inline arrow (`onClose={() => setOpen(false)}`),
  // which is a new identity on every parent render. With `onClose` in the deps,
  // any parent re-render tore this effect down and set it back up — running
  // `previouslyFocused.focus()` then `focusable[0].focus()` — so focus jumped to
  // the first focusable node (the Dialog header's Close button) on EVERY
  // keystroke, because the parent also owns the input's state.
  //
  // That made two shipped features unusable: the review-response editor
  // (reviews-client.tsx) and QuickFlagPanel's notes textarea both accepted
  // exactly one character at a time. It was latent for every other Dialog
  // caller whose input state lives in the same component as the Dialog.
  // Assigned in its own effect, not during render — a ref write during render
  // is a React rule violation (and an ESLint error here). The handler only
  // reads it on a keypress, well after commit, so the one-render lag is not
  // observable.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current

    // Don't steal focus if it is already inside the panel. Belt-and-braces
    // against the bug above, and it also stops an autoFocus'd field being
    // yanked to the Close button on open.
    if (!panel?.contains(document.activeElement)) {
      panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus()
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return

      // Queried per keypress rather than captured once at open: a panel whose
      // fields render conditionally (a disclosure, a validation message, an
      // async-loaded row) would otherwise have those nodes permanently outside
      // the trap.
      const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (!focusable || focusable.length === 0) return

      const first = focusable[0]!
      const last  = focusable[focusable.length - 1]!

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
  }, [open, panelRef])
}
