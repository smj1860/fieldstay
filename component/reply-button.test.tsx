import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const markProspectReplied = vi.fn()
vi.mock('@/app/admin/prospects/agents-actions', () => ({
  markProspectReplied: (...a: unknown[]) => markProspectReplied(...a),
}))

import { ReplyButton } from '@/app/admin/prospects/reply-button'

beforeEach(() => {
  markProspectReplied.mockReset().mockResolvedValue({ stopped: 0 })
})

describe('ReplyButton', () => {
  it('records the reply for THIS account with what they said', async () => {
    render(<ReplyButton prospectId="p1" />)
    fireEvent.change(screen.getByLabelText('What they said (optional)'), { target: { value: 'call me Friday' } })
    fireEvent.click(screen.getByRole('button', { name: 'They replied' }))
    await waitFor(() => expect(markProspectReplied).toHaveBeenCalledWith('p1', 'call me Friday'))
  })

  it('clears the note after a successful record', async () => {
    render(<ReplyButton prospectId="p1" />)
    const input = screen.getByLabelText('What they said (optional)') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'They replied' }))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it.each([
    [0, /Follow-up emails for this account are paused/],
    [1, /1 queued email draft for this account stopped/],
    [3, /3 queued email drafts for this account stopped/],
  ])('says what it did when %s drafts were stopped', async (stopped, expected) => {
    markProspectReplied.mockResolvedValue({ stopped })
    render(<ReplyButton prospectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'They replied' }))
    expect(await screen.findByRole('status')).toHaveTextContent(expected)
  })

  it('shows a refusal instead of swallowing it', async () => {
    markProspectReplied.mockResolvedValue({ error: 'That account is closed. Reopen it first if they have come back.' })
    render(<ReplyButton prospectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'They replied' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('closed')
  })

  it('keeps the note when it fails, so it can be sent again', async () => {
    markProspectReplied.mockResolvedValue({ error: 'Operation failed. Please try again.' })
    render(<ReplyButton prospectId="p1" />)
    const input = screen.getByLabelText('What they said (optional)') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'They replied' }))
    await screen.findByRole('alert')
    expect(input.value).toBe('keep me')
  })
})
