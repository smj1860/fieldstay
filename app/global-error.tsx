'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ background: '#0a1628', color: '#fff', fontFamily: 'sans-serif' }}>
        <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong.</h1>
          <p style={{ color: '#9ab5cc', margin: '12px 0 20px' }}>
            Please refresh the page. If this continues, contact support.
          </p>
          <button
            onClick={reset}
            style={{
              background: '#FCD116', color: '#0a1628', fontWeight: 700,
              padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
