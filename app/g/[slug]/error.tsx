'use client'

import { useEffect } from 'react'

// Matches the "Guidebook Coming Soon" inactive-state branch in
// components/guidebook/guest-guidebook-view.tsx — same charcoal/gold
// constants, since this route never uses the app's --bg-card / -themed vars.
const CHARCOAL = '#0E0E0E'
const MUTED    = '#9A9AA2'
const GOLD     = '#D4A537'

export default function GuestGuidebookError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[guest-guidebook-error]', error.digest, error.message)
  }, [error])

  return (
    <div
      style={{
        minHeight:      '100vh',
        background:     CHARCOAL,
        color:          '#F4F4F5',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        '24px',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: '420px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
          We couldn&apos;t load your guidebook
        </h1>
        <p style={{ fontSize: '14px', color: MUTED, lineHeight: 1.6, marginBottom: '20px' }}>
          Something went wrong loading your check-in details. Please try again, or contact your host
          directly if you need your door code or wifi password right away.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            background:   GOLD,
            color:        CHARCOAL,
            border:       'none',
            borderRadius: '999px',
            padding:      '10px 24px',
            fontSize:     '14px',
            fontWeight:   700,
            cursor:       'pointer',
          }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
