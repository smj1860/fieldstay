'use client'

import { useEffect } from 'react'
import { AlarmClock } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export default function CrewInviteError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[crew-invite-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="bg-card-themed rounded-2xl p-8 max-w-md w-full text-center">
        <AlarmClock className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--accent-amber)' }} />
        <h2 className="text-lg font-bold text-primary-themed mb-2">We couldn&apos;t load your invite</h2>
        <p className="text-sm text-muted-themed mb-6">
          Something went wrong on our end. Try again, or ask your property manager to resend the invite
          link if it keeps happening.
        </p>
        <Button onClick={reset} variant="secondary" className="w-full">Try again</Button>
      </div>
    </div>
  )
}
