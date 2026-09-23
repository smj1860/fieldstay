import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The panels inside the dialog each load from the server on mount; this test
// is about the editor itself, so they are stubbed to nothing.
vi.mock('@/app/admin/prospects/contacts-panel', () => ({
  ContactsPanel: () => <div data-testid="contacts-panel" />,
}))
vi.mock('@/app/admin/prospects/history-panel', () => ({
  HistoryPanel: () => <div data-testid="history-panel" />,
}))

import { ProspectEditDialog } from '@/app/admin/prospects/edit-dialog'
import type { ProspectRow } from '@/app/admin/prospects/constants'

// ============================================================================
// The funnel's only editor used to be an expand-in-place panel behind an
// unlabelled 14px chevron, rendered inside the list's horizontally-scrolling
// ten-column table — so on a phone the fields sat off the right edge and the
// page read as though nothing on it could be edited. Nothing covered it.
//
// These assert the two things that complaint was actually about: the fields
// are reachable and typing into them produces a save.
// ============================================================================

function makeRow(over: Partial<ProspectRow> = {}): ProspectRow {
  return {
    id: 'p1', company: 'Acme Rentals', domain: null, website: null,
    city: null, state: null, market: null, portfolio_size: null,
    pms: null, pms_note: null, score_a: null, score_b: null,
    track: null, bucket: null, contact_name: null, contact_title: null,
    email: null, email_is_generic: false, email_status: 'unknown',
    phone: null, linkedin_url: null, status: 'new', status_note: null,
    notes: null, last_touch_at: null, next_action_at: null,
    comparent_url: null, last_crawled_at: null, crawl_status: null,
    ...over,
  }
}

function renderDialog(over: Partial<ProspectRow> = {}, accepted = true) {
  const onSave = vi.fn().mockResolvedValue(accepted)
  const onClose = vi.fn()
  render(
    <ProspectEditDialog
      row={makeRow(over)}
      open
      saveError=""
      onClose={onClose}
      onSave={onSave}
      onPrimaryChanged={vi.fn()}
    />,
  )
  return { onSave, onClose }
}

describe('ProspectEditDialog', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('offers an input for every field a person fills in by hand', () => {
    renderDialog()
    for (const label of [
      'Contact name', 'Title', 'Email', 'Phone', 'LinkedIn URL',
      'Company name', 'Website', 'Domain', 'City', 'State', 'Market', 'PMS',
      'Status', 'Next action',
      'How the PMS was identified', 'Status note', 'Notes',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
  })

  it('saves an email typed onto an account that had none', async () => {
    const { onSave } = renderDialog()

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'dana@acme.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ email: 'dana@acme.com' }))
  })

  it('sends only the fields that changed', async () => {
    const { onSave } = renderDialog({ contact_name: 'Old Name', city: 'Knoxville' })

    fireEvent.change(screen.getByLabelText('Contact name'), {
      target: { value: 'New Name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // Not city, which the form rendered but nobody touched — a whole-form
    // save would rewrite every column and make the audit row's field list
    // meaningless.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ contact_name: 'New Name' }))
  })

  it('saves a status change and a next action together', async () => {
    const { onSave } = renderDialog()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'emailed' } })
    fireEvent.change(screen.getByLabelText('Next action'), { target: { value: '2026-10-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ status: 'emailed', next_action_at: '2026-10-01' }),
    )
  })

  it('clears a field to empty rather than refusing to send it', async () => {
    const { onSave } = renderDialog({ email: 'old@acme.com' })

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // The server action turns '' into NULL; the dialog must not silently drop
    // the edit just because the new value is empty.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ email: '' }))
  })

  it('disables saving until something actually changes', () => {
    const { onSave, onClose } = renderDialog()

    const button = screen.getByRole('button', { name: 'No changes' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes after a save so the list is what you land back on', async () => {
    const { onSave, onClose } = renderDialog()

    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '8655550142' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('stays open with the draft intact when the server rejects the save', async () => {
    const { onSave, onClose } = renderDialog({}, false)

    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'taken.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    // Closing here would throw away everything the person just typed.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Domain')).toHaveValue('taken.com')
  })

  it('surfaces a rejected save instead of leaving the row looking written', () => {
    render(
      <ProspectEditDialog
        row={makeRow()}
        open
        saveError="Another account already has that domain."
        onClose={vi.fn()}
        onSave={vi.fn()}
        onPrimaryChanged={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Another account already has that domain.')
  })

  it('says why an account is not being refreshed from Comparent', () => {
    renderDialog()
    expect(screen.getByText(/not eligible for "Refresh from Comparent\./)).toBeInTheDocument()
  })
})
