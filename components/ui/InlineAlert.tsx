import type { HTMLAttributes } from 'react'

type Tone = 'success' | 'error' | 'warning' | 'info'

const toneStyle: Record<Tone, { background: string; borderColor: string; color: string }> = {
  success: { background: 'var(--accent-green-dim)', borderColor: 'var(--accent-green)', color: 'var(--accent-green)' },
  error:   { background: 'var(--accent-red-dim)',   borderColor: 'var(--accent-red)',   color: 'var(--accent-red)'   },
  // Added for the (auth) forms, which were the last place still hand-rolling
  // these banners out of Tailwind color utilities (bg-amber-50 / bg-blue-50 …).
  warning: { background: 'var(--accent-amber-dim)', borderColor: 'var(--accent-amber)', color: 'var(--accent-amber)' },
  info:    { background: 'var(--accent-blue-dim)',  borderColor: 'var(--accent-blue)',  color: 'var(--accent-blue)'  },
}

/**
 * `alert` interrupts a screen reader immediately; `status` waits for a pause.
 * Something has gone wrong is worth interrupting for, a confirmation is not —
 * so error/warning get `alert` and success/info get `status`.
 *
 * This also gives tests a selector tied to MEANING rather than to styling.
 * e2e/specs/01-auth.spec.ts asserted the login failure banner with
 * `.bg-red-50`, which broke the moment those banners moved to CSS variables —
 * the test was green because of a colour class, and a colour class is not what
 * "the user was told their password was wrong" means.
 */
const toneRole: Record<Tone, 'alert' | 'status'> = {
  success: 'status',
  error:   'alert',
  warning: 'alert',
  info:    'status',
}

interface InlineAlertProps extends HTMLAttributes<HTMLDivElement> {
  tone: Tone
}

/** Shared success/error banner — replaces the app's previously duplicated
 *  (and inconsistently-shaded) `bg-red-50 border-red-200 text-red-700` /
 *  `bg-red-950 border-red-800 text-red-400` inline banners. */
export function InlineAlert({ tone, className = '', style, ...props }: Readonly<InlineAlertProps>) {
  return (
    <div
      // Before the spread, so an unusual call site can still override it.
      role={toneRole[tone]}
      className={`text-sm rounded-lg border px-3 py-2 ${className}`}
      style={{ ...toneStyle[tone], ...style }}
      {...props}
    />
  )
}
