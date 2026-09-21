import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ============================================================================
// This erasure is irreversible and org-wide, and the component's own comment
// claims it is "behind a typed confirmation... [because] an operator acting
// on a ticket is one paste away from scrubbing the wrong guest." The dialog
// actually only echoed the address back as static, read-only text with a
// plain Cancel / Erase permanently confirm — no input the operator had to
// type into, so it relied on them re-READING a value they may have just
// pasted, not re-TYPING it. That is a plain confirm dialog, measurably
// weaker than what the comment (and the compliance requirement) describes.
// ============================================================================

const erasureMock = vi.fn(async (..._args: unknown[]) => ({
  success: true, bookingsAnonymized: 2, optInsDeleted: 1, optInsRetained: 0,
}))
vi.mock('@/app/(dashboard)/settings/privacy/actions', () => ({
  anonymizeGuestData: (...a: unknown[]) => erasureMock(...a),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { ErasureForm } from '@/app/(dashboard)/settings/privacy/erasure-form'

function emailInput() {
  return screen.getByLabelText(/Guest email address/)
}

function confirmInput() {
  return screen.getByLabelText('Re-type the guest email address to confirm')
}

function dialogEraseButton() {
  // The dialog's own confirm button, distinct from the form's submit button
  // of the same accessible name (the trigger, still mounted behind it).
  const buttons = screen.getAllByRole('button', { name: /Erase permanently|Erase guest data/ })
  return buttons[buttons.length - 1]!
}

async function openConfirmDialog(email = 'guest@example.com') {
  render(<ErasureForm />)
  fireEvent.change(emailInput(), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Erase guest data' }))
  await screen.findByText("Erase this guest's data?")
}

beforeEach(() => { erasureMock.mockClear() })

describe('ErasureForm — typed confirmation', () => {
  it('disables the confirm button until the address is re-typed exactly', async () => {
    await openConfirmDialog('guest@example.com')

    expect(dialogEraseButton()).toBeDisabled()
    fireEvent.click(dialogEraseButton())
    expect(erasureMock).not.toHaveBeenCalled()
  })

  it('leaves the confirm button disabled for a partial or mistyped re-entry', async () => {
    await openConfirmDialog('guest@example.com')

    fireEvent.change(confirmInput(), { target: { value: 'guest@example.co' } })
    expect(dialogEraseButton()).toBeDisabled()

    fireEvent.change(confirmInput(), { target: { value: 'wrong@example.com' } })
    expect(dialogEraseButton()).toBeDisabled()
  })

  it('enables the confirm button once the address is re-typed exactly, case-insensitively', async () => {
    await openConfirmDialog('guest@example.com')

    fireEvent.change(confirmInput(), { target: { value: 'Guest@Example.com' } })
    expect(dialogEraseButton()).not.toBeDisabled()

    fireEvent.click(dialogEraseButton())
    await waitFor(() => expect(erasureMock).toHaveBeenCalledWith('guest@example.com'))
  })

  it('resets the typed confirmation when the dialog is reopened for a different address', async () => {
    await openConfirmDialog('guest@example.com')
    fireEvent.change(confirmInput(), { target: { value: 'guest@example.com' } })
    expect(dialogEraseButton()).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.change(emailInput(), { target: { value: 'other@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Erase guest data' }))
    await screen.findByText("Erase this guest's data?")

    // The stale confirmation text from the first address must not silently
    // authorize erasure of a second, different one.
    expect(dialogEraseButton()).toBeDisabled()
  })
})
