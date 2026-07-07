'use client'

import { useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

export default function DashboardSegmentError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[dashboard-segment-error]', error.digest, error.message)
  }, [error])

  return (
    <Card className="text-center py-12">
      <p className="text-primary-themed font-semibold mb-1">Something went wrong loading this page.</p>
      <p className="text-muted-themed text-sm mb-4">
        This has been logged. Try again, or contact support if it keeps happening.
      </p>
      <Button variant="secondary" onClick={reset}>Try again</Button>
    </Card>
  )
}
