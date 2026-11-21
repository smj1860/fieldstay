import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const requestCallBrief = vi.fn()
vi.mock('@/app/admin/prospects/agents-actions', () => ({
  requestCallBrief: (...a: unknown[]) => requestCallBrief(...a),
}))

import { CallBriefButton } from '@/app/admin/prospects/call-brief-button'

beforeEach(() => { requestCallBrief.mockReset().mockResolvedValue({}) })

describe('CallBriefButton', () => {
  it('asks for a brief for THIS account and says where it will appear', async () => {
    render(<CallBriefButton prospectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare call brief' }))
    await waitFor(() => expect(requestCallBrief).toHaveBeenCalledWith('p1'))
    expect(await screen.findByRole('status')).toHaveTextContent('Agents approval inbox')
  })

  it('shows a refusal as an alert instead of swallowing it', async () => {
    requestCallBrief.mockResolvedValue({ error: 'Turn on the master switch and Sales Ops first.' })
    render(<CallBriefButton prospectId="p1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare call brief' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('master switch')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says it places no call', () => {
    render(<CallBriefButton prospectId="p1" />)
    expect(screen.getByText(/You place the call yourself/)).toBeInTheDocument()
  })
})
