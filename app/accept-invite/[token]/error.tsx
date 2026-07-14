'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export default function AcceptInviteError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[accept-invite-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-brand-800">
      <div className="text-center max-w-sm">
        <div className="flex justify-center mb-4">
          <AlertTriangle className="w-12 h-12 text-gold-300" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">
          We couldn&apos;t load your invitation
        </h1>
        <p className="text-sm text-brand-200 mb-6">
          Something went wrong on our end. Try again, or ask whoever invited you to resend the link if
          it keeps happening.
        </p>
        <Button onClick={reset} variant="cta">Try again</Button>
      </div>
    </div>
  )
}
