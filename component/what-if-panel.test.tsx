import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ============================================================================
// The <Input type="number" min={0} max={25}> attributes only engage HTML5
// constraint validation on a native form submit / .reportValidity() call.
// Save here is a plain onClick driven by React state, so the min/max range
// was never actually enforced client-side — a value outside 0-25 went
// straight to updateCapexInflationRate() verbatim, relying entirely on the
// server action's own guard to reject it after a round trip, with the
// result then silently dropped either way (`if (!result.error) setSaved
// (true)` — the else branch did nothing, so a rejected save looked
// identical to a successful one).
// ============================================================================

const updateMock = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('@/app/(dashboard)/capital-planning/actions', () => ({
  updateCapexInflationRate: (...a: unknown[]) => updateMock(...a),
}))

import { WhatIfPanel } from '@/app/(dashboard)/capital-planning/what-if-panel'

function renderPanel(initial = 3) {
  render(
    <WhatIfPanel
      projections={{ 2026: { total_low: 1000, total_high: 2000 } }}
      currentYear={2026}
      initialInflationRatePct={initial}
    />,
  )
}

function rateInput() {
  return screen.getByLabelText('Annual inflation rate') as HTMLInputElement
}

function saveButton() {
  return screen.getByRole('button', { name: /Save as org default/ })
}

beforeEach(() => { updateMock.mockClear() })

describe('WhatIfPanel — inflation rate save validation', () => {
  it('saves a normal in-range value straight through', async () => {
    renderPanel(3)
    fireEvent.change(rateInput(), { target: { value: '5' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(5))
  })

  it('disables Save for a value above the 25% ceiling and never calls the server action', async () => {
    renderPanel(3)
    fireEvent.change(rateInput(), { target: { value: '9999' } })
    expect(saveButton()).toBeDisabled()
    fireEvent.click(saveButton())
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('disables Save for a negative value and never calls the server action', async () => {
    renderPanel(3)
    fireEvent.change(rateInput(), { target: { value: '-5' } })
    expect(saveButton()).toBeDisabled()
    fireEvent.click(saveButton())
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('surfaces a server-rejected value instead of silently doing nothing', async () => {
    updateMock.mockResolvedValueOnce({ error: 'Inflation rate must be between 0% and 25%.' })
    renderPanel(3)
    fireEvent.change(rateInput(), { target: { value: '10' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Inflation rate must be between 0% and 25%.')).toBeInTheDocument()
  })
})
