'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, Check }                from 'lucide-react'
import { triggerCapexProjections }      from './actions'
import { createClient }                 from '@/lib/supabase/client'
import { Button }                       from '@/components/ui/Button'

export function TriggerProjectionsButton({
  orgId,
  currentYear,
}: Readonly<{
  orgId:       string
  currentYear: number
}>) {
  const [loading, setLoading]     = useState(false)
  const [polling, setPolling]     = useState(false)
  const [done,    setDone]        = useState(false)
  const [timedOut, setTimedOut]   = useState(false)
  const attemptsRef = useRef(0)

  const handleClick = async () => {
    setLoading(true)
    setDone(false)
    setTimedOut(false)
    await triggerCapexProjections()
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
        .eq('milestone', `capex_projection_${currentYear}`)
        .maybeSingle()

      if (data?.value) {
        setPolling(false)
        setDone(true)
        clearInterval(interval)
        window.location.reload()
        return
      }

      if (attemptsRef.current >= 20) {
        setPolling(false)
        setTimedOut(true)
        clearInterval(interval)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [polling, orgId, currentYear])

  if (timedOut) {
    return (
      <span className="text-xs font-medium" style={{ color: 'var(--accent-amber)' }}>
        Still processing — check back in a moment
      </span>
    )
  }
  if (done) {
    return (
      <span className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
        <Check className="w-3.5 h-3.5" /> Projections updated
      </span>
    )
  }

  return (
    <Button
      onClick={handleClick}
      disabled={loading || polling}
      variant="secondary"
      className="text-sm flex items-center gap-1.5"
    >
      {(loading || polling)
        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {loading ? 'Starting…' : 'Generating…'}</>
        : 'Generate Projections'}
    </Button>
  )
}
