'use client'

import { useState, useTransition } from 'react'
import { revealPropertyDoorCode } from '@/app/(dashboard)/properties/actions'

/**
 * Door codes are masked by default on the read-only property detail view —
 * revealing decrypts server-side and audit-logs the view (property.door_code.viewed)
 * rather than shipping the plaintext code to the client on every page load.
 */
export function DoorCodeReveal({ propertyId }: Readonly<{ propertyId: string }>) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleReveal() {
    setError(null)
    startTransition(async () => {
      const result = await revealPropertyDoorCode(propertyId)
      if ('error' in result) {
        setError(result.error)
        return
      }
      setRevealed(result.doorCode ?? '—')
    })
  }

  if (revealed !== null) {
    return <span>{revealed}</span>
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleReveal}
        disabled={pending}
        className="text-sm underline disabled:opacity-60"
        style={{ color: 'var(--accent-blue)' }}
      >
        {pending ? 'Revealing…' : '•••• Reveal'}
      </button>
      {error && <span className="text-xs" style={{ color: 'var(--accent-red)' }}>{error}</span>}
    </span>
  )
}
