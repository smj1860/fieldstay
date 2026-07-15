'use client'
import { Loader2, ChevronRight, CheckSquare, Package, StickyNote, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { TurnoverRow } from '@/lib/dexie/schema'
import type { TurnoverActions } from './use-turnover-actions'

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
  const { completedCount, totalCount, inventoryItems, actionError, completing, markInProgress, markComplete } = actions

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

      {/* Start Turnover — only if status === 'assigned' */}
      {turnover.status === 'assigned' && (
        <Button variant="secondary" onClick={() => void markInProgress()} className="w-full py-4 text-base">
          Start Turnover
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
        disabled={completing || turnover.status === 'completed'}
        className="w-full py-4 text-base flex items-center justify-center gap-2
                   disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {completing
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
          : turnover.status === 'completed'
          ? <><Check className="w-4 h-4" /> Marked Complete</>
          : 'Mark as Complete'}
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
