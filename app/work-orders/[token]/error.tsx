'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'

export default function WorkOrderPortalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error('[work-order-portal-error]', error.digest, error.message)
  }, [error])

  return (
    <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
      <div className="bg-card-themed rounded-2xl shadow-[0_4px_24px_0_rgba(0,0,0,.10)] w-full max-w-md p-8 text-center">
        <span className="text-brand-800 text-2xl font-black tracking-tight block mb-1">FieldStay</span>
        <p className="text-accent-400 text-xs mb-6">Vendor Portal</p>
        <p className="text-primary-themed font-semibold mb-1">We couldn&apos;t load this work order.</p>
        <p className="text-muted-themed text-sm mb-6">
          This has been logged. Please try again, or contact the property manager who sent you this link
          if it keeps happening.
        </p>
        <Button onClick={reset} variant="secondary" className="w-full">Try again</Button>
      </div>
    </div>
  )
}
