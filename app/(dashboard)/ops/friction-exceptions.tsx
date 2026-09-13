'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { acceptSmartFix, dismissFrictionFlag } from './actions'
import type { FlaggedTurnover } from '@/lib/friction/flagged-for-dashboard'

/**
 * Today's pre-flight friction exceptions.
 *
 * HIDDEN WHEN EMPTY, like the Upcoming Inspections section beside it. An "all
 * clear" card would compete for attention with the real exceptions elsewhere
 * on this page, and the whole point of an exceptions panel is that its
 * presence is the signal.
 *
 * The percentages are an internal ops estimate from a deterministic scorer
 * (lib/scoring/friction.ts), not a measured rate — the copy says "risk", never
 * a precision claim, and nothing here is LLM-generated.
 */
export function FrictionExceptions({ rows }: Readonly<{ rows: FlaggedTurnover[] }>) {
  if (rows.length === 0) return null

  const criticalCount = rows.filter((r) => r.severity === 'critical').length

  return (
    <div
      className="rounded-xl p-4 mb-6"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <p
          className="text-xs font-semibold uppercase tracking-wide inline-flex items-center gap-1.5"
          style={{ color: 'var(--text-muted)' }}
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Today&apos;s at-risk turnovers
          {criticalCount > 0 && (
            <span style={{ color: 'var(--accent-red)' }}>· {criticalCount} critical</span>
          )}
        </p>
      </div>

      <ul className="space-y-3">
        {rows.map((row) => (
          <FrictionRow key={row.id} row={row} />
        ))}
      </ul>
    </div>
  )
}

function FrictionRow({ row }: Readonly<{ row: FlaggedTurnover }>) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (action: () => Promise<{ error?: string }>) => {
    setError(null)
    startTransition(async () => {
      const result = await action()
      // A refused write returns 0 rows and no error from PostgREST, so the
      // action reports that as a message rather than a silent no-op. Surfacing
      // it is the difference between "nothing happened" and "you were told
      // nothing happened".
      if (result.error) setError(result.error)
    })
  }

  return (
    <li
      className="rounded-lg px-3 py-2.5"
      style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
            {row.propertyName ?? 'Unnamed property'}
          </p>
          {row.reasons.length > 0 && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Driven by {row.reasons.join(' and ')}
            </p>
          )}
        </div>

        <Badge tone={row.severity === 'critical' ? 'red' : 'amber'}>
          {Math.round(row.failureProbability * 100)}% risk
        </Badge>
      </div>

      {row.smartFixCrewId && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span
            className="text-xs inline-flex items-center gap-1"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
            Smart Fix:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {row.smartFixReasoning ?? row.smartFixCrewName ?? 'suggested crew'}
            </strong>
          </span>

          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
            <Button
              variant="secondary"
              className="text-xs px-2 py-1"
              disabled={pending}
              onClick={() => run(() => acceptSmartFix(row.id))}
            >
              Accept Smart Fix
            </Button>
            <Button
              variant="ghost"
              className="text-xs px-2 py-1"
              disabled={pending}
              onClick={() => run(() => dismissFrictionFlag(row.id))}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* No Smart Fix — every crew member is already on this turnover, or the
          org has none. Dismiss is still offered: the PM must be able to clear
          a card they have handled, whether or not we had a suggestion. */}
      {!row.smartFixCrewId && (
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            className="text-xs px-2 py-1"
            disabled={pending}
            onClick={() => run(() => dismissFrictionFlag(row.id))}
          >
            Dismiss
          </Button>
        </div>
      )}

      {error && (
        <p className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>
          {error}
        </p>
      )}
    </li>
  )
}
