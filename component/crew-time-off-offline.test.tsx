import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ============================================================================
// Time off is the ONE crew screen with no offline fallback. Every other crew
// write goes through the Dexie outbox and survives a dead zone; this one is
// deliberately a live Server Action (see app/crew/availability/actions.ts for
// why — syncing a year of availability to every device to back a screen nobody
// opens without signal was not worth it).
//
// Which makes "Failed to save — please try again" the least useful thing it
// could say: retrying is precisely what will not work, and nothing else on the
// crew app behaves this way, so the crew member has no reason to suspect this
// screen is different. They tap Save, see a generic failure, tap again, and
// conclude the app is broken.
// ============================================================================

const saveCrewAvailability = vi.fn()
vi.mock('@/app/crew/availability/actions', () => ({
  saveCrewAvailability: (...a: unknown[]) => saveCrewAvailability(...a),
}))

const isOnline = vi.fn(() => true)
vi.mock('@/lib/dexie/net', () => ({ isOnline: () => isOnline() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { TimeOffRequest } from '@/components/crew/time-off-request'

/** Toggles the first day in the week view, which reveals the Save button. */
function toggleFirstDayAndSave() {
  const dayButtons = screen.getAllByRole('button').filter((b) => /\w{3} \d+/.test(b.textContent ?? ''))
  fireEvent.click(dayButtons[0]!)
  fireEvent.click(screen.getByText('Save Changes'))
}

describe('crew time off — a failure says whether the connection is the cause', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOnline.mockReturnValue(true)
  })

  it('names being offline as the reason, rather than telling them to retry', async () => {
    isOnline.mockReturnValue(false)
    saveCrewAvailability.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<TimeOffRequest rows={[]} />)
    toggleFirstDayAndSave()

    expect(await screen.findByText(/offline/i)).toBeTruthy()
    expect(screen.queryByText(/please try again/i)).toBeNull()
  })

  // The guard must not swallow genuine server failures into an offline
  // message — a 500 while online is not a connectivity problem, and telling
  // the crew member it is would send them looking for signal they already have.
  it('keeps the generic retry message when the device is online', async () => {
    isOnline.mockReturnValue(true)
    saveCrewAvailability.mockRejectedValue(new Error('boom'))

    render(<TimeOffRequest rows={[]} />)
    toggleFirstDayAndSave()

    expect(await screen.findByText(/please try again/i)).toBeTruthy()
    expect(screen.queryByText(/offline/i)).toBeNull()
  })

  // The action's own refusals (validation, a row that vanished) are returned,
  // not thrown, and must reach the crew member verbatim.
  it('surfaces a refusal returned by the action', async () => {
    saveCrewAvailability.mockResolvedValue({ error: 'That date is outside the window you can request time off for.' })

    render(<TimeOffRequest rows={[]} />)
    toggleFirstDayAndSave()

    expect(await screen.findByText(/outside the window/i)).toBeTruthy()
  })
})
