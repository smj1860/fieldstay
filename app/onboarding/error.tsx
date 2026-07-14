'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'

// Onboarding is a PM-facing flow (not a guest/vendor/owner portal), so this
// follows the internal (dashboard) error-boundary pattern rather than the
// bespoke branding of the other public routes. Renders inside layout.tsx's
// white card — no full-page wrapper needed here.
export default function OnboardingError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[onboarding-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="text-center py-4">
      <p className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Something went wrong setting up your account.
      </p>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        This has been logged. Try again, or contact support if it keeps happening.
      </p>
      <Button onClick={reset} variant="secondary">Try again</Button>
    </div>
  )
}
