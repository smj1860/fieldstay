'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'

type AutoAssignMode = 'disabled' | 'suggest' | 'autopilot'

interface AutoAssignWizardStepProps {
  initialMode: AutoAssignMode
  continueAction: (mode: AutoAssignMode) => Promise<void>
}

const OPTIONS: Array<{ value: AutoAssignMode; label: string; description: string }> = [
  {
    value: 'disabled',
    label: 'Manual only',
    description: 'You assign crew to every turnover yourself. No suggestions.',
  },
  {
    value: 'suggest',
    label: 'Suggest crew',
    description: 'FieldStay recommends the best crew member. You approve or override before the job is dispatched.',
  },
  {
    value: 'autopilot',
    label: 'Autopilot',
    description: 'FieldStay automatically assigns and notifies crew. You only intervene if flagged.',
  },
]

export function AutoAssignWizardStep({ initialMode, continueAction }: AutoAssignWizardStepProps) {
  const [selected, setSelected] = useState<AutoAssignMode>(initialMode)
  const [isPending, startTransition] = useTransition()

  function handleSubmit() {
    startTransition(async () => {
      await continueAction(selected)
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setSelected(opt.value)}
            className="w-full text-left rounded-xl border px-4 py-3 transition-colors"
            style={{
              borderColor: selected === opt.value ? 'var(--accent-gold)' : 'var(--border)',
              background: selected === opt.value ? 'var(--accent-gold-dim)' : 'var(--bg-card)',
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center"
                style={{
                  borderColor: selected === opt.value ? 'var(--accent-gold)' : 'var(--border)',
                }}
              >
                {selected === opt.value && (
                  <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent-gold)' }} />
                )}
              </div>
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {opt.label}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {opt.description}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <Button
        type="button"
        onClick={handleSubmit}
        disabled={isPending}
      >
        {isPending ? 'Saving…' : 'Continue →'}
      </Button>
    </div>
  )
}
