import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const updateUser        = vi.fn()
const signOut           = vi.fn()
const getSession        = vi.fn()
const onAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { updateUser, signOut, getSession, onAuthStateChange } }),
}))

import { ResetPasswordForm } from '@/app/(auth)/reset-password/reset-password-form'

// ============================================================================
// updateUser({ password }) changes the password and leaves EVERY existing
// session alive — on every device, including whoever the reset was meant to
// evict. So the most common reason to reset a password ("someone got into my
// account") did not actually do the one thing it is for: the intruder kept a
// working session, and only the password they no longer needed had changed.
//
// The form now calls signOut({ scope: 'global' }) before routing to /login.
// ============================================================================

async function fillAndSubmit(pw = 'correct horse battery') {
  fireEvent.change(await screen.findByLabelText(/^New Password$/i), { target: { value: pw } })
  fireEvent.change(screen.getByLabelText(/^Confirm New Password$/i), { target: { value: pw } })
  fireEvent.submit(screen.getByRole('button', { name: /Update Password/i }))
}

describe('reset-password — session revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } })
    updateUser.mockResolvedValue({ error: null })
    signOut.mockResolvedValue({ error: null })
  })

  it('revokes every session globally after the password is updated', async () => {
    render(<ResetPasswordForm />)
    await fillAndSubmit()

    // findByText resolves once the success banner renders, which only happens
    // after the signOut await above it has settled — so this is the same
    // "wait for the async work" the waitFor was doing, without polling.
    await screen.findByText(/Password updated/i)
    // 'global', not the default local scope — a local sign-out drops only the
    // browser doing the reset and leaves the intruder's session untouched.
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' })
  })

  it('does not sign anything out when the password update itself failed', async () => {
    updateUser.mockResolvedValue({ error: { message: 'Password is too weak' } })

    render(<ResetPasswordForm />)
    await fillAndSubmit()

    expect(await screen.findByText(/too weak/i)).toBeTruthy()
    expect(signOut).not.toHaveBeenCalled()
  })

  // The password IS already changed by this point, so "reset failed" would be a
  // lie — but silently succeeding would tell someone their account is secured
  // when the other sessions may still be live. That distinction is the whole
  // point of the message.
  it('tells the user their other devices are still signed in if revocation fails', async () => {
    signOut.mockResolvedValue({ error: { message: 'network' } })

    render(<ResetPasswordForm />)
    await fillAndSubmit()

    expect(await screen.findByText(/could not sign out your other devices/i)).toBeTruthy()
    expect(screen.queryByText(/Password updated/i)).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  it('refuses to submit at all when the two passwords differ', async () => {
    render(<ResetPasswordForm />)
    fireEvent.change(await screen.findByLabelText(/^New Password$/i), { target: { value: 'aaaaaaaa' } })
    fireEvent.change(screen.getByLabelText(/^Confirm New Password$/i), { target: { value: 'bbbbbbbb' } })
    fireEvent.submit(screen.getByRole('button', { name: /Update Password/i }))

    expect(await screen.findByText(/Passwords do not match/i)).toBeTruthy()
    expect(updateUser).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })
})
