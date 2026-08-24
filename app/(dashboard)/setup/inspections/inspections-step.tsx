'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { CalendarClock, Wrench } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import {
  MONTH_NAMES,
  describeSafetyTemplate,
  type SafetyFrequency,
} from '@/lib/inspections/safety-template'

interface Props {
  initialFrequency:  SafetyFrequency
  initialStartMonth: number
  propertyCount:     number
  saveAction:        (frequency: SafetyFrequency, startMonth: number) => Promise<void>
}

const FREQUENCIES: Array<{ value: SafetyFrequency; label: string; description: string }> = [
  {
    value: 'annual',
    label: 'Once a year',
    description: 'One safety walk per property, in the month you choose.',
  },
  {
    value: 'semi_annual',
    label: 'Twice a year',
    description: 'Two walks, six months apart. The second month follows from the first.',
  },
]

export function InspectionsWizardStep({
  initialFrequency, initialStartMonth, propertyCount, saveAction,
}: Readonly<Props>) {
  const [frequency,  setFrequency]  = useState<SafetyFrequency>(initialFrequency)
  const [startMonth, setStartMonth] = useState<number>(initialStartMonth)
  const [error,      setError]      = useState<string | null>(null)
  const [isPending,  startTransition] = useTransition()

  const summary = describeSafetyTemplate({ frequency, startMonth })

  // Named rather than nested inside the JSX ternary below: two conditionals in
  // one expression is the shape the lint budget is a ratchet against, and the
  // pluralisation is a separate decision from "has any properties at all".
  const noun  = propertyCount === 1 ? 'property' : 'properties'
  const scope = propertyCount === 0
    ? 'No properties yet — this will apply to each one as you add it.'
    : `Applied to all ${propertyCount} ${noun}, and to any you add later.`

  const submit = () => {
    setError(null)
    startTransition(async () => {
      try {
        await saveAction(frequency, startMonth)
      } catch (err) {
        // A thrown Server Action reaches the client as a generic message in
        // production, so this shows what we can and keeps the PM on the step
        // rather than dropping them on the error boundary for a retryable save.
        setError(err instanceof Error ? err.message : 'Could not save. Please try again.')
      }
    })
  }

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
          How often
        </legend>
        {FREQUENCIES.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={frequency === opt.value}
            onClick={() => setFrequency(opt.value)}
            className="w-full text-left rounded-xl border px-4 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            style={{
              borderColor: frequency === opt.value ? 'var(--accent-gold)' : 'var(--border)',
              background:  frequency === opt.value ? 'var(--accent-gold-dim)' : 'var(--bg-card)',
            }}
          >
            <span className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {opt.label}
            </span>
            <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {opt.description}
            </span>
          </button>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="safety-start-month" className="text-sm font-semibold"
               style={{ color: 'var(--text-secondary)' }}>
          Starting month
        </label>
        <select
          id="safety-start-month"
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

      {/* The answer read back as a sentence. For twice-a-year the second month
          is DERIVED, so a PM who picks March needs to see September before they
          commit rather than discover it on the Maintenance board. */}
      <div
        className="flex items-start gap-2.5 rounded-xl px-4 py-3"
        style={{ background: 'var(--accent-gold-dim)', border: '1px solid var(--accent-gold)' }}
      >
        <CalendarClock className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-gold)' }} />
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
          <strong>{summary}</strong>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {scope}
          </span>
        </p>
      </div>

      {/* §2 keeps Indoor and Outdoor out of onboarding on purpose. Saying why,
          here, is what stops this reading as a feature we forgot. */}
      <div
        className="flex items-start gap-2.5 rounded-xl px-4 py-3"
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
      >
        <Wrench className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          There are two more inspections — <strong>Indoor</strong> and <strong>Outdoor</strong> —
          and they are set up per property rather than across the board, because a
          condo and a lakefront house with a dock do not need the same walk. Add them
          as recurring maintenance on the properties that want them, choosing
          &ldquo;Inspection&rdquo; when you create the schedule.{' '}
          <Link
            href="/maintenance"
            className="font-semibold underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
            style={{ color: 'var(--accent-gold)' }}
          >
            Maintenance schedules
          </Link>
        </p>
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'var(--accent-red)' }} role="alert">
          {error}
        </p>
      )}

      <Button variant="cta" onClick={submit} disabled={isPending} className="w-full">
        {isPending ? 'Saving…' : 'Save and continue'}
      </Button>
    </div>
  )
}
