'use client'

import { useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

export default function OwnerPortalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[owner-portal-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="min-h-screen bg-canvas-themed flex items-center justify-center p-4">
      <Card className="text-center max-w-sm w-full">
        <p className="text-primary-themed font-semibold mb-1">
          We couldn&apos;t load your property report.
        </p>
        <p className="text-muted-themed text-sm mb-4">
          This has been logged. Please try again, or contact your property manager if the problem continues.
        </p>
        <Button onClick={reset} variant="secondary">Try again</Button>
      </Card>
    </div>
  )
}
