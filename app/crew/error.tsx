'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

export default function CrewError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[crew-error-boundary]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <AlertTriangle className="w-10 h-10 text-amber-400 mb-4" />
      <h2 className="text-base font-semibold text-primary-themed mb-1">Something went wrong</h2>
      <p className="text-sm text-muted-themed mb-6">
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <button
        onClick={reset}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold"
        style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)' }}
      >
        Try again
      </button>
    </div>
  )
}
