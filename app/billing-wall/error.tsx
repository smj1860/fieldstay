'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'

// Billing-wall is a PM-facing flow (not a guest/vendor/owner portal), so the
// copy follows the internal (dashboard) error-boundary pattern. No layout.tsx
// wraps this route, so the full-page card shell from page.tsx is reproduced
// here rather than assumed from a parent.
export default function BillingWallError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[billing-wall-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-base)' }}>
      <div
        className="w-full max-w-md rounded-2xl p-8 text-center"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
      >
        <p className="text-2xl font-bold tracking-tight mb-6" style={{ color: 'var(--text-primary)' }}>
          FieldStay
        </p>
        <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          We couldn&apos;t load your billing status
        </h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>
          This has been logged. Try again, or contact support if it keeps happening.
        </p>
        <Button onClick={reset} variant="secondary">Try again</Button>
      </div>
    </div>
  )
}
