import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ============================================================================
// "Mark ordered" is the only moment purchase_orders.total_estimated_cost
// (null on every row until this) gets a real number, and it posts straight
// to the property's owner ledger. Before this fix, submitOrdered() accepted
// any Number.isFinite value >= 0 with no upper bound and no comparison
// against the estimate already on hand — a PM typing "15000" instead of
// "1500" (or "4500" instead of "45.00") posted a materially wrong expense
// with no confirmation step and no undo path.
// ============================================================================

const updateMock = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('@/app/(dashboard)/inventory/actions', () => ({
  updatePurchaseOrderStatus: (...a: unknown[]) => updateMock(...a),
}))

import { PurchaseOrderActions } from '@/components/inventory/purchase-order-actions'

function openOrderedDialog(totalEstimatedCost: number | null = 40) {
  render(
    <PurchaseOrderActions
      purchaseOrderId="po-1"
      status="sent"
      totalEstimatedCost={totalEstimatedCost}
      onDone={() => {}}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Mark ordered' }))
}

function amountInput() {
  return screen.getByLabelText('Total spent (optional)')
}

function markOrderedButtons() {
  return screen.getAllByRole('button', { name: /Mark ordered/ })
}

/** The dialog's own submit button — the last "Mark ordered" on the page,
 *  distinct from the trigger button behind the (still-mounted) dialog. */
function submitButton() {
  const buttons = markOrderedButtons()
  return buttons[buttons.length - 1]!
}

beforeEach(() => { updateMock.mockClear() })

describe('PurchaseOrderActions — mark ordered amount', () => {
  it('posts a normal amount straight through, no confirmation needed', async () => {
    openOrderedDialog(40)
    fireEvent.change(amountInput(), { target: { value: '45.00' } })
    fireEvent.click(submitButton())
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('po-1', 'ordered', 45))
  })

  it('rejects a hex-parseable value instead of silently posting the wrong number', async () => {
    // Number("0x64") is 100 even though the field visually reads decimal-only.
    openOrderedDialog(40)
    fireEvent.change(amountInput(), { target: { value: '0x64' } })
    fireEvent.click(submitButton())
    expect(await screen.findByText(/Enter a dollar amount/)).toBeInTheDocument()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('flags a suspiciously large amount against the estimate rather than posting it immediately', async () => {
    openOrderedDialog(40)
    // 45x the $40 estimate — the "extra digit" shape the finding describes.
    fireEvent.change(amountInput(), { target: { value: '1800' } })
    fireEvent.click(submitButton())

    expect(await screen.findByText(/45\.0x the estimate/)).toBeInTheDocument()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('proceeds on a SECOND click of the same flagged amount — that is the confirmation', async () => {
    openOrderedDialog(40)
    fireEvent.change(amountInput(), { target: { value: '1800' } })
    fireEvent.click(submitButton())
    await screen.findByText(/45\.0x the estimate/)

    fireEvent.click(submitButton())
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('po-1', 'ordered', 1800))
  })

  it('does not let a stale confirmation carry over after the amount is edited', async () => {
    openOrderedDialog(40)
    fireEvent.change(amountInput(), { target: { value: '1800' } })
    fireEvent.click(submitButton())
    await screen.findByText(/45\.0x the estimate/)

    // Edited to a DIFFERENT large amount — must re-flag, not silently post
    // under the confirmation earned by the previous number.
    fireEvent.change(amountInput(), { target: { value: '1900' } })
    fireEvent.click(submitButton())

    expect(await screen.findByText(/47\.5x the estimate/)).toBeInTheDocument()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('never flags an outlier when there is no estimate to compare against', async () => {
    openOrderedDialog(null)
    fireEvent.change(amountInput(), { target: { value: '5000' } })
    fireEvent.click(submitButton())
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('po-1', 'ordered', 5000))
  })

  it('still allows an empty amount through with no confirmation', async () => {
    openOrderedDialog(40)
    fireEvent.change(amountInput(), { target: { value: '' } })
    fireEvent.click(submitButton())
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('po-1', 'ordered', undefined))
  })
})
