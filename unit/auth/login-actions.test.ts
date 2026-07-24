import { describe, it, expect, vi, beforeEach } from 'vitest'

// app/(auth)/login/actions.ts exports acceptInviteForCurrentUser — a
// currently-authenticated-user invite-acceptance action, not a password
// login flow (there's no separate password-login Server Action in this
// codebase's login route — sign-in there posts directly to Supabase Auth
// from a client component). It doesn't call requireOrgMember(), since the
// caller may not have an org membership yet — that's the entire point of
// this action — so there's no requireOrgMember auth-rejection path to test
// here, unlike the settings/* actions in this batch.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/auth/invites', () => ({
  acceptOrgInvite: vi.fn(),
}))

import { acceptInviteForCurrentUser } from '@/app/(auth)/login/actions'
import { createClient } from '@/lib/supabase/server'
import { acceptOrgInvite } from '@/lib/auth/invites'

function makeSupabase(user: { id: string; email: string } | null) {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user } }),
    },
  }
}

describe('login/actions — acceptInviteForCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns not-accepted when there is no authenticated user, without calling acceptOrgInvite', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabase(null) as never)

    const result = await acceptInviteForCurrentUser('tok_abc')

    expect(result).toEqual({ accepted: false })
    expect(acceptOrgInvite).not.toHaveBeenCalled()
  })

  it('returns not-accepted when the authenticated user has no email, without calling acceptOrgInvite', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ id: 'user_1', email: '' }) as never
    )

    const result = await acceptInviteForCurrentUser('tok_abc')

    expect(result).toEqual({ accepted: false })
    expect(acceptOrgInvite).not.toHaveBeenCalled()
  })

  it('delegates to acceptOrgInvite with the authenticated user id/email and the supplied token', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: true, orgId: 'org_1' })

    const result = await acceptInviteForCurrentUser('tok_abc')

    expect(result).toEqual({ accepted: true })
    expect(acceptOrgInvite).toHaveBeenCalledWith('user_1', 'pm@example.com', 'tok_abc')
  })

  it('returns not-accepted when acceptOrgInvite reports the token as invalid/expired', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: false })

    const result = await acceptInviteForCurrentUser('expired-or-bogus-token')

    expect(result).toEqual({ accepted: false })
  })

  it('swallows a thrown error from acceptOrgInvite and returns not-accepted', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    vi.mocked(acceptOrgInvite).mockRejectedValue(new Error('db unreachable'))

    const result = await acceptInviteForCurrentUser('tok_abc')

    expect(result).toEqual({ accepted: false })
  })
})
