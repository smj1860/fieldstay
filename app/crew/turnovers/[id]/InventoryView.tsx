'use client'
import { CheckCircle2, Circle, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { retryFailedMutation } from '@/lib/dexie/helpers'
import type { TurnoverRow } from '@/lib/dexie/schema'
import type { TurnoverActions } from './use-turnover-actions'

export function InventoryView({
  turnover,
  actions,
  onBack,
}: Readonly<{
  turnover: TurnoverRow
  actions:  TurnoverActions
  onBack:   () => void
}>) {
  const {
    userId,
    inventoryItems, invByCategory, getCount, handleCountChange,
    toggleInventoryConfirm, inventoryConfirmSyncFailed,
  } = actions

  return (
    <div className="mt-2">
      <h2 className="text-base font-semibold mb-3 px-1" style={{ color: 'var(--text-primary)' }}>
        Inventory
      </h2>

      {/* Inventory section */}
      {inventoryItems && inventoryItems.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2 px-1">
            Inventory
          </h3>
          <div className="space-y-3">
            {Object.entries(invByCategory).map(([category, catItems]) => (
              <div key={category}>
                <p className="text-xs text-muted-themed font-medium uppercase tracking-wide mb-1.5 px-1">
                  {category.replace(/_/g, ' ')}
                </p>
                <div className="bg-card-themed rounded-xl border border-themed divide-y divide-themed overflow-hidden">
                  {catItems.map((item) => {
                    const qty    = getCount(item)
                    const isLow  = qty < item.par_level
                    return (
                      <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-primary-themed truncate">{item.name}</p>
                          <p className="text-xs text-muted-themed">
                            Par {item.par_level} {item.unit}
                            {isLow && (
                              <span className="ml-1.5 font-medium" style={{ color: 'var(--accent-amber)' }}>· Low</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleCountChange(item.id, qty - 1)}
                            className="rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
                            style={{ width: 48, height: 48 }}
                            aria-label={`Decrease ${item.name}`}
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <input
                            type="number"
                            min={0}
                            value={qty}
                            onChange={(e) => handleCountChange(item.id, parseInt(e.target.value, 10) || 0)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              e.preventDefault()
                              const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-inv-count-input]'))
                              const idx = inputs.indexOf(e.currentTarget)
                              inputs[idx + 1]?.focus()
                            }}
                            data-inv-count-input
                            aria-label={`${item.name} count`}
                            className="w-12 text-center text-sm font-semibold text-primary-themed border border-themed rounded-lg py-1 focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                            style={{ height: 48 }}
                          />
                          <button
                            onClick={() => handleCountChange(item.id, qty + 1)}
                            className="rounded-lg border border-themed flex items-center justify-center text-muted-themed hover:bg-raised-themed active:bg-raised-themed transition-colors"
                            style={{ width: 48, height: 48 }}
                            aria-label={`Increase ${item.name}`}
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-themed text-center mt-2">Inventory updates save automatically</p>
        </div>
      )}

      {/* Confirm Inventory Complete — no validation condition exists to
          block this on (unlike the checklist's required-photo check), so
          it's a pure assertion. Same unchecking/lock-once-completed rules
          as the checklist confirm box. */}
      <button
        type="button"
        onClick={() => void toggleInventoryConfirm()}
        disabled={turnover.status === 'completed'}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 mt-2 mb-4 text-left transition-colors',
          !turnover.inventory_confirmed_complete_at && 'border-themed hover:bg-raised-themed',
          turnover.status === 'completed' && 'cursor-not-allowed'
        )}
        style={turnover.inventory_confirmed_complete_at ? { borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' } : undefined}
      >
        {turnover.inventory_confirmed_complete_at
          ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
          : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
        <p className="text-base font-semibold" style={{ color: turnover.inventory_confirmed_complete_at ? 'var(--accent-green)' : 'var(--text-primary)' }}>
          Confirm Inventory Complete
        </p>
      </button>

      {inventoryConfirmSyncFailed && (
        <div
          className="flex items-center justify-between gap-2 -mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
          style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
        >
          <span>Confirmation didn&rsquo;t sync — check your connection.</span>
          <button
            type="button"
            className="font-semibold underline flex-shrink-0"
            onClick={() => void retryFailedMutation(userId, 'turnovers', turnover.id)}
          >
            Retry
          </button>
        </div>
      )}

      <div className="sticky bottom-0 pt-3 pb-6" style={{ background: 'var(--bg-page)' }}>
        <Button
          variant="secondary"
          onClick={onBack}
          className="w-full py-3"
        >
          ← Back to Turnover
        </Button>
      </div>
    </div>
  )
}
