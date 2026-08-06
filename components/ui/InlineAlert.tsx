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

interface InlineAlertProps extends HTMLAttributes<HTMLDivElement> {
  tone: Tone
}

/** Shared success/error banner — replaces the app's previously duplicated
 *  (and inconsistently-shaded) `bg-red-50 border-red-200 text-red-700` /
 *  `bg-red-950 border-red-800 text-red-400` inline banners. */
export function InlineAlert({ tone, className = '', style, ...props }: Readonly<InlineAlertProps>) {
  return (
    <div
      className={`text-sm rounded-lg border px-3 py-2 ${className}`}
      style={{ ...toneStyle[tone], ...style }}
      {...props}
    />
  )
}
