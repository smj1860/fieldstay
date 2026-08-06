import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/auth/invites', () => ({ acceptOrgInvite: vi.fn() }))

import { GET } from '@/app/(auth)/callback/route'
import { createClient } from '@/lib/supabase/server'
import { acceptOrgInvite } from '@/lib/auth/invites'

// ============================================================================
// The OAuth callback used to redirect to /ops the moment acceptOrgInvite
// RETURNED, without looking at whether it had accepted anything.
//
// acceptOrgInvite returns { accepted: false } for an expired or already-claimed
// token, an email that does not match the invite, a lost claim race, and —
// deliberately — a crew-role org invite, which it refuses because an
// organization_members row would grant a cleaner read access to the entire
// org's turnovers, bookings and guest PII.
//
// In every one of those cases the user reached /ops with no membership row,
// requireOrgMember() bounced them to /onboarding, and they were shown "Name
// your organization" with nothing explaining what had happened. Someone who
// clicked "join my teammate's account" silently created their own separate org
// instead — and the org they were meant to join never gained a member.
//
// The password-signup path (acceptTeamInvite) has always checked this result
// and even deletes the auth user it created when acceptance fails. The two
// OAuth/login paths did not. This pins the callback half.
// ============================================================================

const ORIGIN = 'https://app.fieldstay.test'

function makeSupabase(session: { user: { id: string; email: string; created_at: string; app_metadata?: Record<string, unknown> } } | null) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async () => ({
        data: session ? { session } : { session: null },
        error: null,
      })),
    },
  }
}

const SESSION = {
  user: {
    id:           'user_1',
    email:        'invitee@example.com',
    created_at:   new Date(Date.now() - 10 * 86_400_000).toISOString(),
    app_metadata: { provider: 'google' },
  },
}

function request(params: Record<string, string>) {
  const url = new URL(`${ORIGIN}/auth/callback`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url)
}

describe('(auth)/callback — invite acceptance result is honoured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createClient).mockResolvedValue(makeSupabase(SESSION) as never)
  })

  it('sends an accepted invitee to /ops', async () => {
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: true, orgId: 'org_1' })

    const res = await GET(request({ code: 'abc', invite_token: 'tok_1' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/ops`)
  })

  it('does NOT send a rejected invitee to /ops — the defect', async () => {
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: false })

    const res = await GET(request({ code: 'abc', invite_token: 'tok_expired' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/onboarding?invite=invalid`)
  })

  // The crew-role refusal is the case where silently proceeding is worst: it is
  // a deliberate security decision inside acceptOrgInvite, and the old code
  // turned it into "here, make your own organization instead".
  it('routes a refused crew-role org invite to the explanation, not to org creation', async () => {
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: false })

    const res = await GET(request({ code: 'abc', invite_token: 'tok_crew_role' }))

    expect(res.headers.get('location')).toContain('invite=invalid')
    expect(res.headers.get('location')).not.toContain('/ops')
  })

  it('passes the session user id and email through to acceptOrgInvite', async () => {
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: true, orgId: 'org_1' })

    await GET(request({ code: 'abc', invite_token: 'tok_1' }))

    expect(acceptOrgInvite).toHaveBeenCalledWith('user_1', 'invitee@example.com', 'tok_1')
  })

  it('leaves the no-invite path alone', async () => {
    const res = await GET(request({ code: 'abc', next: '/setup' }))

    expect(acceptOrgInvite).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe(`${ORIGIN}/setup`)
  })

  // Pre-existing behaviour, pinned so the invite branch above cannot be
  // refactored into swallowing a genuine auth failure.
  it('redirects to /login when there is no code at all', async () => {
    const res = await GET(request({}))

    expect(res.headers.get('location')).toContain('/login?error=auth_callback_missing_code')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects an absolute or protocol-relative next, falling back to /onboarding', async () => {
    const res = await GET(request({ code: 'abc', next: '//evil.example.com' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/onboarding`)
  })
})
