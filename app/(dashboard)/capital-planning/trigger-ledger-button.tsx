'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { triggerDepreciationLedger } from './actions'

export function TriggerLedgerButton({ taxYear, orgId }: { taxYear: number; orgId: string }) {
  const [loading, setLoading] = useState(false)
  const [done,    setDone]    = useState(false)

  const handleClick = async () => {
    setLoading(true)
    await triggerDepreciationLedger(taxYear, orgId)
    setLoading(false)
    setDone(true)
  }

  if (done) {
    return (
      <span className="text-xs font-medium" style={{ color: 'var(--accent-green)' }}>
        ✓ Queued
      </span>
    )
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="btn-primary text-sm flex items-center gap-1.5"
    >
      {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</> : `Generate ${taxYear} Ledger`}
    </button>
  )
}
