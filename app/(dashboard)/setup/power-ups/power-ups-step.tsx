'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { Button, buttonVariantClass } from '@/components/ui/Button'

interface NextStep {
  title: string
  body:  string
  href:  string
  label: string
}

const NEXT_STEPS: NextStep[] = [
  {
    title: 'Finish your templates',
    body:  'Your inventory and turnover checklist templates got a head start already — finish customizing par levels, rooms, and maintenance schedules whenever it\'s convenient.',
    href:  '/templates',
    label: 'Go to Templates',
  },
  {
    title: 'Guidebook & sponsors',
    body:  'Set up the guest-facing guidebook for each property — WiFi, check-in instructions, house rules. You can also invite local businesses as guidebook sponsors; their offers help offset your subscription cost.',
    href:  '/guidebook',
    label: 'Go to Guidebook',
  },
  {
    title: 'Review your assets',
    body:  'FieldStay auto-detected assets like HVAC units, water heaters, and appliances from your PMS data on import. Review them so health scores and depreciation tracking start accurate.',
    href:  '/assets',
    label: 'Go to Assets',
  },
  {
    title: 'Crew app',
    body:  'Your crew already sees their turnover checklists in the crew app — nothing else to set up there.',
    href:  '/crew-manage',
    label: 'Manage Crew',
  },
]

interface PowerUpsStepProps {
  krogerConnected: boolean
  finishAction:    () => Promise<void>
}

export function PowerUpsStep({ krogerConnected, finishAction }: Readonly<PowerUpsStepProps>) {
  const [isPending, startTransition] = useTransition()

  function handleFinish() {
    startTransition(async () => {
      await finishAction()
    })
  }

  return (
    <div className="space-y-6">
      <div
        className="rounded-xl border px-4 py-3 flex items-center justify-between gap-4"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Kroger
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Automatically build a Kroger cart when inventory drops below par.
          </div>
        </div>
        {krogerConnected ? (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
            style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
          >
            Connected
          </span>
        ) : (
          <Link
            href="/settings/integrations"
            className={buttonVariantClass('secondary') + ' text-xs flex-shrink-0'}
          >
            Connect
          </Link>
        )}
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          A few things worth exploring next
        </p>
        {NEXT_STEPS.map((step) => (
          <div
            key={step.title}
            className="rounded-xl border px-4 py-3"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {step.title}
              </div>
              <Link
                href={step.href}
                className="text-xs underline flex-shrink-0"
                style={{ color: 'var(--accent-gold)' }}
              >
                {step.label}
              </Link>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {step.body}
            </p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleFinish} disabled={isPending}>
          {isPending ? 'Finishing…' : 'Finish setup →'}
        </Button>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          None of this is required — revisit any of it later from Settings or the page itself.
        </span>
      </div>
    </div>
  )
}
