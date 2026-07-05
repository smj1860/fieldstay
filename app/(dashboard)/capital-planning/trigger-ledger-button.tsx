'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, Check } from 'lucide-react'
import { triggerDepreciationLedger } from './actions'
import { createClient } from '@/lib/supabase/client'

export function TriggerLedgerButton({ taxYear, orgId }: Readonly<{ taxYear: number; orgId: string }>) {
  const [loading, setLoading]   = useState(false)
  const [polling, setPolling]   = useState(false)
  const [result,  setResult]    = useState<{ entries: number; total: number } | 'empty' | 'timeout' | null>(null)
  const attemptsRef = useRef(0)

  const handleClick = async () => {
    setLoading(true)
    setResult(null)
    await triggerDepreciationLedger(taxYear, orgId)
    setLoading(false)
    setPolling(true)
    attemptsRef.current = 0
  }

  useEffect(() => {
    if (!polling) return
    const supabase = createClient()

    const interval = setInterval(async () => {
      attemptsRef.current++

      const { data } = await supabase
        .from('org_milestones')
        .select('value')
        .eq('org_id', orgId)
        .eq('milestone', `depreciation_ledger_${taxYear}`)
        .maybeSingle()

      const value = data?.value as { entry_count?: number; total_depr?: number } | undefined

      if (value) {
        setResult(
          (value.entry_count ?? 0) > 0
            ? { entries: value.entry_count!, total: value.total_depr ?? 0 }
            : 'empty'
        )
        setPolling(false)
        clearInterval(interval)
        window.location.reload()
        return
      }

      if (attemptsRef.current >= 15) {
        setResult('timeout')
        setPolling(false)
        clearInterval(interval)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [polling, orgId, taxYear])

  if (result === 'empty') {
    return (
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        No eligible assets — set purchase price and placed-in-service date on at least one asset
      </span>
    )
  }
  if (result === 'timeout') {
    return (
      <span className="text-xs font-medium" style={{ color: 'var(--accent-amber)' }}>
        Still processing — check back in a minute
      </span>
    )
  }
  if (result && typeof result === 'object') {
    return (
      <span className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
        <Check className="w-3.5 h-3.5" /> {result.entries} {result.entries === 1 ? 'entry' : 'entries'} generated
      </span>
    )
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading || polling}
      className="btn-primary text-sm flex items-center gap-1.5"
    >
      {(loading || polling)
        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {loading ? 'Starting…' : 'Generating…'}</>
        : `Generate ${taxYear} Ledger`}
    </button>
  )
}
