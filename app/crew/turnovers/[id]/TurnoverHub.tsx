'use client'
import { Loader2, ChevronRight, CheckSquare, Package, StickyNote, Check, Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { TurnoverRow } from '@/lib/dexie/schema'
import type { TurnoverActions } from './use-turnover-actions'

/**
 * Extracted rather than left as a chained ternary: adding the cancelled state
 * made it a third branch, and CLAUDE.md bans nested conditionals.
 */
function markCompleteLabel(completing: boolean, isComplete: boolean, isCancelled: boolean) {
  if (completing)  return <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
  if (isComplete)  return <><Check className="w-4 h-4" /> Marked Complete</>
  if (isCancelled) return 'Turnover Cancelled'
  return 'Mark as Complete'
}

export function TurnoverHub({
  turnover,
  actions,
  onOpenChecklist,
  onOpenInventory,
  onOpenSummary,
  onMarkCompleteSuccess,
}: Readonly<{
  turnover:              TurnoverRow
  actions:               TurnoverActions
  onOpenChecklist:       () => void
  onOpenInventory:       () => void
  onOpenSummary:         () => void
  onMarkCompleteSuccess: () => void
}>) {
  const {
    completedCount, totalCount, inventoryItems, actionError, completing,
    markInProgress, checkInAgainNow, markComplete, flagLate, isCancelled,
  } = actions

  const alreadyFlaggedLate = Boolean(turnover.crew_running_late_at)

  return (
    <div className="space-y-3 mt-4">
      {actionError && (
        <div
          className="px-4 py-3 rounded-xl text-sm font-medium"
          style={{
            backgroundColor: 'var(--accent-red-dim)',
            color:           'var(--accent-red)',
            border:          '1px solid rgba(240,84,84,0.2)',
          }}
        >
          {actionError}
        </div>
      )}

      {/* Progress summary — show checklist completion at a glance */}
      {totalCount > 0 && (
        <div className="rounded-xl px-4 py-3 flex items-center justify-between"
             style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Checklist progress
          </span>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {completedCount} / {totalCount}
          </span>
        </div>
      )}

      {/* Start Turnover — only if status === 'assigned' and not cancelled.
          `assigned` and `cancelled` are not mutually exclusive on the device:
          cancelTurnoversForBooking() flips turnovers.status server-side, and
          the crew row keeps whatever the last pull wrote — so this needs its
          own check rather than relying on the status equality above. */}
      {turnover.status === 'assigned' && !isCancelled && (
        <Button variant="secondary" onClick={() => void markInProgress()} className="w-full py-4 text-base">
          Start Turnover
        </Button>
      )}

      {/* Check in again: the first fix rides on Start; this re-records where the
          crew is mid-visit (a poor first fix, or arriving at the unit after the
          driveway). The newest check-in wins for the packet. */}
      {turnover.status === 'in_progress' && !isCancelled && (
        <Button variant="ghost" onClick={() => void checkInAgainNow()} className="w-full py-3 text-sm">
          Check in again
        </Button>
      )}

      {/* Running late. Not gated on the turnover having started: the moment
          worth raising it is usually before anything has been ticked, stuck in
          traffic or waiting on a guest who has not left. One tap, and a
          second one is a no-op rather than a second notification. */}
      {!isCancelled && (
        <Button
          variant={alreadyFlaggedLate ? 'ghost' : 'secondary'}
          onClick={() => void flagLate()}
          disabled={alreadyFlaggedLate}
          className="w-full py-4 text-base"
        >
          {alreadyFlaggedLate
            ? <><Check className="w-4 h-4" /> Your manager has been told</>
            : <><Clock className="w-4 h-4" /> I am running late</>}
        </Button>
      )}

      {/* Navigation buttons */}
      <button
        onClick={onOpenChecklist}
        className="w-full py-4 rounded-xl flex items-center justify-between px-5 text-base font-medium"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      >
        <div className="flex items-center gap-3">
          <CheckSquare className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
          Turnover Checklist
        </div>
        <div className="flex items-center gap-2">
          {totalCount > 0 && (
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {completedCount}/{totalCount}
            </span>
          )}
          <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        </div>
      </button>

      {inventoryItems && inventoryItems.length > 0 && (
        <button
          onClick={onOpenInventory}
          className="w-full py-4 rounded-xl flex items-center justify-between px-5 text-base font-medium"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        >
          <div className="flex items-center gap-3">
            <Package className="w-5 h-5" style={{ color: 'var(--accent-blue)' }} />
            Inventory
          </div>
          <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        </button>
      )}

      {/* Mark Complete */}
      <Button
        variant="cta"
        onClick={() => markComplete(onMarkCompleteSuccess)}
        disabled={completing || turnover.status === 'completed' || isCancelled}
        className="w-full py-4 text-base flex items-center justify-center gap-2
                   disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {markCompleteLabel(completing, turnover.status === 'completed', isCancelled)}
      </Button>

      {/* Turnover Summary & Additional Notes — secondary, at the bottom */}
      <button
        onClick={onOpenSummary}
        className="w-full py-3 rounded-xl text-sm font-medium flex items-center
                   justify-center gap-2 border transition-colors hover:opacity-80"
        style={{
          borderColor: 'var(--accent-amber)',
          background:  'var(--accent-amber-dim)',
          color:       'var(--accent-amber)',
        }}
      >
        <StickyNote className="w-4 h-4" />
        Turnover Summary & Additional Notes
      </button>
    </div>
  )
}
