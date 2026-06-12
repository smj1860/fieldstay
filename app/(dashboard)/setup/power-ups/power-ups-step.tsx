'use client'

import Link from 'next/link'
import { useTransition } from 'react'

interface PowerUp {
  title: string
  description: string
  href: string
  connected: boolean
}

interface PowerUpsStepProps {
  powerUps: PowerUp[]
  finishAction: () => Promise<void>
}

export function PowerUpsStep({ powerUps, finishAction }: PowerUpsStepProps) {
  const [isPending, startTransition] = useTransition()

  function handleFinish() {
    startTransition(async () => {
      await finishAction()
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {powerUps.map((pu) => (
          <div
            key={pu.title}
            className="rounded-xl border px-4 py-3 flex items-center justify-between gap-4"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
          >
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {pu.title}
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {pu.description}
              </div>
            </div>
            {pu.connected ? (
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
              >
                Connected
              </span>
            ) : (
              <Link
                href={pu.href}
                className="btn-secondary text-xs flex-shrink-0"
              >
                Connect
              </Link>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleFinish}
          disabled={isPending}
          className="btn-primary"
        >
          {isPending ? 'Finishing…' : 'Finish setup →'}
        </button>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          You can connect integrations later in Settings.
        </span>
      </div>
    </div>
  )
}
