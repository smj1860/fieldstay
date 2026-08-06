'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { updatePurchaseOrderStatus } from '@/app/(dashboard)/inventory/actions'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import type { PoStatus } from '@/types/database'

// ============================================================================
// The controls that close the restock loop.
//
// Every path that produces a purchase order ends OUTSIDE FieldStay: the PM
// submits the Kroger cart on kroger.com, or — with no Kroger connection — buys
// the items however they like off the emailed list. Until these buttons
// existed, nothing came back. The PO panel rendered a status that could never
// leave `sent`, and `purchase-order/approved` (the event that posts the
// restock expense to the owner ledger) had no producer that could ever run.
//
// "Mark ordered" takes an amount because it is the only moment the real spend
// is known: a count carries quantities, not prices, so purchase_orders.
// total_estimated_cost is null on every row in production and no automated
// step ever fills it in. Without the amount the ledger entry is skipped and
// the loop still does not close.
// ============================================================================

interface PurchaseOrderActionsProps {
  purchaseOrderId:    string
  status:             PoStatus
  totalEstimatedCost: number | null
  onDone:             () => void
}

/** Terminal states have nothing left to do — see PO_TRANSITIONS in actions.ts. */
const TERMINAL: ReadonlySet<PoStatus> = new Set(['received', 'cancelled'])

export function PurchaseOrderActions({
  purchaseOrderId,
  status,
  totalEstimatedCost,
  onDone,
}: Readonly<PurchaseOrderActionsProps>) {
  const [showOrdered, setShowOrdered] = useState(false)
  const [amount, setAmount] = useState(
    totalEstimatedCost != null ? totalEstimatedCost.toFixed(2) : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (TERMINAL.has(status)) return null

  function run(next: 'ordered' | 'received' | 'cancelled', totalCost?: number) {
    setError(null)
    startTransition(async () => {
      const res = await updatePurchaseOrderStatus(purchaseOrderId, next, totalCost)
      if (res.error) {
        setError(res.error)
        return
      }
      setShowOrdered(false)
      onDone()
    })
  }

  function submitOrdered() {
    const trimmed = amount.trim()
    // Empty is allowed: a PM who genuinely does not know the total yet should
    // still be able to record that the order was placed. The expense simply
    // is not posted, which is the same outcome as before — not a regression,
    // and far better than forcing a made-up number into the owner ledger.
    if (trimmed === '') {
      run('ordered')
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Enter a dollar amount, or leave it blank.')
      return
    }
    run('ordered', parsed)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
      {status === 'ordered' ? (
        <Button variant="primary" className="text-xs px-3 py-1.5" disabled={pending} onClick={() => run('received')}>
          {pending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Mark received
        </Button>
      ) : (
        <Button variant="primary" className="text-xs px-3 py-1.5" disabled={pending} onClick={() => setShowOrdered(true)}>
          Mark ordered
        </Button>
      )}

      <Button variant="ghost" className="text-xs px-3 py-1.5" disabled={pending} onClick={() => run('cancelled')}>
        Cancel order
      </Button>

      {error && !showOrdered && <InlineAlert tone="error" className="w-full">{error}</InlineAlert>}

      {showOrdered && (
        <Dialog
          open
          onClose={() => setShowOrdered(false)}
          title="Mark as ordered"
          footer={
            <>
              <Button variant="secondary" disabled={pending} onClick={() => setShowOrdered(false)}>
                Back
              </Button>
              <Button variant="primary" className="ml-auto" disabled={pending} onClick={submitOrdered}>
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                Mark ordered
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-secondary-themed">
              Record what you actually spent on this restock. The amount posts to the
              property&apos;s owner ledger as a restock expense.
            </p>
            <div className="flex flex-col gap-1">
              <label htmlFor="po-total" className="text-xs font-medium text-muted-themed">
                Total spent (optional)
              </label>
              <Input
                id="po-total"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            {error && <InlineAlert tone="error">{error}</InlineAlert>}
          </div>
        </Dialog>
      )}
    </div>
  )
}
