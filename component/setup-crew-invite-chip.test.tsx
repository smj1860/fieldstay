import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const inviteCrewMember = vi.fn()
const addCrewMember    = vi.fn()

vi.mock('@/app/(dashboard)/settings/actions', () => ({
  inviteCrewMember: (...args: unknown[]) => inviteCrewMember(...args),
  addCrewMember:    (...args: unknown[]) => addCrewMember(...args),
}))

import { SetupCrewStep } from '@/app/(dashboard)/setup/crew/setup-crew-client'

// ============================================================================
// The invite button in the setup wizard awaited inviteCrewMember, threw the
// result away, and rendered a green "Invited" unconditionally.
//
// That action has five distinct refusal paths: permission denied, crew member
// not found, no email or phone on file, already has an active account, and a
// failed send. Every one of them rendered as success.
//
// Worse than showing nothing: a PM who has just added an outside cleaner sees
// a tick, believes the link went out, and moves on. The crew member never
// hears anything and the PM has no reason to look again. Both other call sites
// of this action (crew-manage-client.tsx) have always branched on the result —
// this was the odd one out, on the page a PM sees exactly once, during setup,
// with the least context for noticing that nothing happened.
// ============================================================================

const CREW = [{
  id: 'crew_1', name: 'Alex Johnson', role: 'cleaning', specialty: 'cleaning',
  email: null, invite_sent_at: null, user_id: null,
}]

function renderStep() {
  return render(<SetupCrewStep crew={CREW} continueAction={async () => {}} />)
}

describe('setup wizard — crew invite result is honoured', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the refusal instead of a success tick', async () => {
    inviteCrewMember.mockResolvedValue({ error: 'No contact information on file for this crew member' })

    renderStep()
    fireEvent.click(screen.getByRole('button', { name: /Invite to App/i }))

    expect(await screen.findByText(/No contact information on file/i)).toBeTruthy()
    expect(screen.queryByText(/^Invited$/)).toBeNull()
  })

  it('still shows Invited on a real success', async () => {
    inviteCrewMember.mockResolvedValue({ success: true })

    renderStep()
    fireEvent.click(screen.getByRole('button', { name: /Invite to App/i }))

    expect(await screen.findByText(/Invited/i)).toBeTruthy()
  })

  // A viewer clicking this gets "Permission denied" from the action. Rendering
  // that as a tick told them they had just invited someone they cannot invite.
  it('surfaces a permission refusal rather than claiming the invite was sent', async () => {
    inviteCrewMember.mockResolvedValue({ error: 'Permission denied' })

    renderStep()
    fireEvent.click(screen.getByRole('button', { name: /Invite to App/i }))

    expect(await screen.findByText(/Permission denied/i)).toBeTruthy()
    expect(screen.queryByText(/^Invited$/)).toBeNull()
  })

  it('clears a previous error when a retry succeeds', async () => {
    inviteCrewMember.mockResolvedValueOnce({ error: 'Crew member not found' })
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: /Invite to App/i }))
    expect(await screen.findByText(/Crew member not found/i)).toBeTruthy()

    inviteCrewMember.mockResolvedValueOnce({ success: true })
    fireEvent.click(screen.getByRole('button', { name: /Invite to App/i }))

    expect(await screen.findByText(/Invited/i)).toBeTruthy()
    expect(screen.queryByText(/Crew member not found/i)).toBeNull()
  })
})
