'use client'

// The safety cadence, editable — and ONLINE ONLY, on purpose.
//
// This page is a shell that renders from the Dexie cache so a walk can be
// STARTED with no signal (see inspections-view.tsx). A setting is the opposite
// kind of thing: edited rarely, never at a property, and dangerous to show
// stale — a PM who reads "twice a year" from a week-old cache and acts on it
// has been told something that may not be true any more.
//
// So it is fetched on mount and simply ABSENT offline. Nothing is cached,
// nothing is queued, and there is no "you're offline" placeholder either: an
// explanation of why a settings card is missing is noise on a screen whose job
// right now is the walk in front of you.

import { useEffect, useState, useTransition } from 'react'
import { CalendarRange, Pencil } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import {
  MONTH_NAMES,
  describeSafetyTemplate,
  type SafetyFrequency,
} from '@/lib/inspections/safety-template'

import { loadSafetyCadence, saveSafetyCadence } from './safety-cadence-actions'

interface Cadence {
  frequency:     SafetyFrequency | null
  startMonth:    number | null
  propertyCount: number
}

export function SafetyCadenceCard() {
  const [cadence, setCadence] = useState<Cadence | null>(null)
  const [open, setOpen]       = useState(false)

  useEffect(() => {
    let cancelled = false
    // Not even attempted offline. The Server Action would hang until the
    // fetch times out, and the answer is the same either way: no card.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    void loadSafetyCadence().then((result) => {
      if (cancelled || 'error' in result) return
      setCadence(result)
    })
    return () => { cancelled = true }
  }, [])

  // Absent until it has actually loaded — including on a failed load, which is
  // indistinguishable from offline here and wants the same treatment.
  if (!cadence) return null

  const template = cadence.frequency && cadence.startMonth
    ? { frequency: cadence.frequency, startMonth: cadence.startMonth }
    : null

  return (
    <>
      <Card>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-start gap-2.5 min-w-0">
            <CalendarRange className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <span className="min-w-0">
              <span className="block text-xs font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--text-muted)' }}>
                Safety walk cadence
              </span>
              <span className="block text-sm mt-0.5" style={{ color: 'var(--text-primary)' }}>
                {template ? describeSafetyTemplate(template) : 'Not set — every property is unscheduled'}
              </span>
            </span>
          </span>
          <Button variant="secondary" onClick={() => setOpen(true)} className="flex items-center gap-1.5 flex-shrink-0">
            <Pencil className="w-3.5 h-3.5" />
            {template ? 'Change' : 'Set'}
          </Button>
        </div>
      </Card>

      {open && (
        <CadenceDialog
          initialFrequency={cadence.frequency ?? 'semi_annual'}
          initialStartMonth={cadence.startMonth ?? new Date().getMonth() + 1}
          propertyCount={cadence.propertyCount}
          onClose={() => setOpen(false)}
          onSaved={(next) => { setCadence({ ...cadence, ...next }); setOpen(false) }}
        />
      )}
    </>
  )
}

function CadenceDialog({
  initialFrequency, initialStartMonth, propertyCount, onClose, onSaved,
}: Readonly<{
  initialFrequency:  SafetyFrequency
  initialStartMonth: number
  propertyCount:     number
  onClose:  () => void
  onSaved:  (next: { frequency: SafetyFrequency; startMonth: number }) => void
}>) {
  const [frequency,  setFrequency]  = useState<SafetyFrequency>(initialFrequency)
  const [startMonth, setStartMonth] = useState<number>(initialStartMonth)
  const [error,      setError]      = useState<string | null>(null)
  const [saving, startTransition]   = useTransition()

  const noun = propertyCount === 1 ? 'property' : 'properties'

  const save = () => {
    setError(null)
    startTransition(async () => {
      const result = await saveSafetyCadence(frequency, startMonth)
      if (result.error) { setError(result.error); return }
      onSaved({ frequency, startMonth })
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Safety walk cadence"
      mobileSheet
      maxWidthClassName="max-w-md"
      footer={
        <div className="flex gap-2 w-full">
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button variant="cta" onClick={save} disabled={saving} className="flex-1">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cadence-frequency" className="text-xs font-semibold"
                 style={{ color: 'var(--text-secondary)' }}>
            How often
          </label>
          <select
            id="cadence-frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as SafetyFrequency)}
            className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          >
            <option value="annual">Once a year</option>
            <option value="semi_annual">Twice a year</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="cadence-month" className="text-xs font-semibold"
                 style={{ color: 'var(--text-secondary)' }}>
            Starting month
          </label>
          <select
            id="cadence-month"
            value={startMonth}
            onChange={(e) => setStartMonth(Number(e.target.value))}
            className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>{name}</option>
            ))}
          </select>
        </div>

        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {describeSafetyTemplate({ frequency, startMonth })}
        </p>

        {/* Says what a change actually does, including what it leaves alone.
            "It changed some of them" is the kind of thing a PM should read
            before saving rather than work out afterwards. */}
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Applies to all {propertyCount} {noun}. A walk that is already due or
          overdue keeps its date so nothing in progress is disturbed — it picks up
          the new cadence once it is done.
        </p>

        {error && (
          <p className="text-xs" style={{ color: 'var(--accent-red)' }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
