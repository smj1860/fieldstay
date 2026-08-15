'use client'

import { useState, useTransition, useMemo } from 'react'
import { updateCapexInflationRate } from './actions'
import { buildWhatIfScenario, summarizeScenario } from '@/lib/assets/scenario-modeling'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

const DEFER_OPTIONS_MONTHS = [0, 6, 12, 18, 24, 36]

export function WhatIfPanel({
  projections,
  currentYear,
  initialInflationRatePct,
}: Readonly<{
  projections:              Record<number, { total_low: number; total_high: number }>
  currentYear:              number
  initialInflationRatePct:  number
}>) {
  const [inflationRatePct, setInflationRatePct] = useState(initialInflationRatePct)
  const [deferMonths,      setDeferMonths]      = useState(0)
  const [saved,            setSaved]            = useState(false)
  const [pending,          startSave]           = useTransition()

  const scenario = useMemo(
    () => buildWhatIfScenario(projections, currentYear, inflationRatePct, deferMonths / 12),
    [projections, currentYear, inflationRatePct, deferMonths],
  )
  const summary = useMemo(() => summarizeScenario(scenario), [scenario])

  function handleSave() {
    setSaved(false)
    startSave(async () => {
      const result = await updateCapexInflationRate(inflationRatePct)
      if (!result.error) setSaved(true)
    })
  }

  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`

  return (
    <Card className="mb-6">
      <div className="mb-3">
        <h3 className="font-semibold text-primary-themed">What-If: Inflation &amp; Deferral</h3>
        <p className="text-xs text-muted-themed mt-0.5">
          Projects the 10-year plan in real dollars, and compares it against deferring every
          upcoming replacement by the same amount of time.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label htmlFor="what-if-inflation" className="label">Annual inflation rate</label>
          <div className="flex items-center gap-2">
            <Input
              id="what-if-inflation"
              type="number"
              min={0}
              max={25}
              step={0.1}
              value={inflationRatePct}
              onChange={(e) => { setInflationRatePct(Number(e.target.value)); setSaved(false) }}
              className="w-24"
            />
            <span className="text-sm text-muted-themed">%</span>
          </div>
        </div>
        <div>
          <label htmlFor="what-if-defer" className="label">Defer replacements by</label>
          <select
            id="what-if-defer"
            value={deferMonths}
            onChange={(e) => setDeferMonths(Number(e.target.value))}
            className="input"
          >
            {DEFER_OPTIONS_MONTHS.map((m) => (
              <option key={m} value={m}>{m === 0 ? 'Not deferred (baseline)' : `${m} months`}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-themed">
        <div>
          <p className="text-xs text-muted-themed mb-1">10-Year Total — On Schedule</p>
          <p className="text-lg font-bold text-primary-themed">
            {fmt(summary.baselineTotalLow)}–{fmt(summary.baselineTotalHigh)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-themed mb-1">
            10-Year Total — Deferred {deferMonths > 0 ? `${deferMonths}mo` : ''}
          </p>
          <p className="text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>
            {fmt(summary.deferredTotalLow)}–{fmt(summary.deferredTotalHigh)}
          </p>
        </div>
      </div>

      {deferMonths > 0 && (
        <p className="text-xs mt-3" style={{ color: summary.deltaHigh > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
          {summary.deltaHigh > 0
            ? `Deferring costs ${fmt(summary.deltaHigh)} more in real dollars over the plan, once inflation compounds onto the delayed replacements.`
            : `Deferring saves ${fmt(Math.abs(summary.deltaHigh))} in this scenario.`}
        </p>
      )}

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-themed">
        <Button
          type="button"
          variant="ghost"
          onClick={handleSave}
          disabled={pending || inflationRatePct === initialInflationRatePct}
          className="text-xs"
        >
          {pending ? 'Saving…' : 'Save as org default'}
        </Button>
        {saved && <span className="text-xs" style={{ color: 'var(--accent-green)' }}>Saved</span>}
      </div>
    </Card>
  )
}
