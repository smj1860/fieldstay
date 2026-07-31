import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * End-to-end proof of the invite-acceptance rollback (H-1, 2026-07-30
 * pre-launch audit).
 *
 * Unlike unit/auth/accept-invite-actions.test.ts, this suite deliberately does
 * NOT mock @/lib/auth/invites — the REAL acceptOrgInvite() runs inside the real
 * acceptTeamInvite() server action against one shared fake Supabase.
 *
 * That combination is the whole point. Before the fix, acceptOrgInvite()
 * discarded the errors from both the organization_members insert and the
 * org_invites update and returned { accepted: true } unconditionally, so the
 * `if (!accepted) deleteUser(...)` rollback in the action could never fire.
 * Each half looked correct in isolation; only running them together shows
 * whether a failed membership write actually rolls the auth account back
 * instead of leaving a real account, a consumed invite, and no membership —
 * an invitee permanently locked out of the org they were just invited to.
 */

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}))
vi.mock('@/lib/rate-limit', async () => {
  // The action consults the limiter through checkLimit() (the single
  // chokepoint in lib/rate-limit.ts). The stub delegates to the limiter double
  // below, so `expect(inviteAcceptRatelimit.limit).toHaveBeenCalledWith(...)`
  // and the fail-open-on-throw assertions keep working unchanged.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    inviteAcceptRatelimit: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:            checkLimitStub(),
    retryAfterSeconds:     retryAfterSecondsStub,
  }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient:        vi.fn(),
  adminFetch:          vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))
// @/lib/auth/invites is intentionally NOT mocked.

import { acceptTeamInvite } from '@/app/accept-invite/[token]/actions'
import { createServiceClient, createClient, adminFetch } from '@/lib/supabase/server'

// org_invites.token is `encode(gen_random_bytes(32), 'hex')` — 64 hex chars,
// NOT a uuid. A uuid fixture here is what let the .uuid() validation bug ship.
const VALID_TOKEN = 'a'.repeat(64)
const EMAIL       = 'jamie@example.com'
const NEW_USER_ID = 'new_user_1'

const INVITE = {
  id:         'invite_1',
  org_id:     'org_1',
  email:      EMAIL,
  role:       'manager',
  expires_at: '2999-01-01T00:00:00.000Z',
}

/**
 * A single fake Supabase shared by the action and by acceptOrgInvite, with a
 * real-enough org_invites row: accepted_at only transitions away from null
 * once, exactly like the `.is('accepted_at', null)` predicate in the UPDATE's
 * WHERE clause.
 */
function makeSupabase(opts: { membershipInsertError?: { code: string; message: string } } = {}) {
  const state = { acceptedAt: null as string | null, memberships: [] as unknown[] }

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let mode: 'select' | 'update' | 'insert' = 'select'
    let payload: Record<string, unknown> = {}

    chain.select = () => chain
    chain.eq     = () => chain
    chain.is     = () => chain
    chain.gt     = () => chain
    chain.update = (p: Record<string, unknown>) => { mode = 'update'; payload = p; return chain }
    chain.insert = (p: Record<string, unknown>) => { mode = 'insert'; payload = p; return chain }

    const resolve = async () => {
      if (table === 'org_invites' && mode === 'select') {
        return state.acceptedAt === null
          ? { data: INVITE, error: null }
          : { data: null, error: null }
      }
      if (table === 'org_invites' && mode === 'update') {
        if (payload.accepted_at === null) {           // the release
          state.acceptedAt = null
          return { data: null, error: null }
        }
        if (state.acceptedAt !== null) return { data: null, error: null }  // lost the claim
        state.acceptedAt = payload.accepted_at as string
        return { data: { id: INVITE.id }, error: null }
      }
      if (table === 'organization_members' && mode === 'insert') {
        if (opts.membershipInsertError) return { data: null, error: opts.membershipInsertError }
        state.memberships.push(payload)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }

    chain.single      = () => resolve()
    chain.maybeSingle = () => resolve()
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => resolve().then(res, rej)
    return chain
  })

  const auth = {
    admin: {
      createUser: vi.fn(async () => ({ data: { user: { id: NEW_USER_ID } }, error: null })),
      deleteUser: vi.fn(async () => ({ error: null })),
    },
  }

  return { from, auth, state }
}

function validFormData() {
  const fd = new FormData()
  fd.set('token', VALID_TOKEN)
  fd.set('fullName', 'Jamie Rivera')
  fd.set('password', 'supersecret123')
  fd.set('confirm', 'supersecret123')
  return fd
}

describe('accept-invite rollback — real acceptOrgInvite wired into the real server action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(adminFetch).mockResolvedValue(
      { ok: true, json: async () => ({ users: [] }) } as unknown as Response,
    )
    vi.mocked(createClient).mockResolvedValue(
      { auth: { signInWithPassword: vi.fn(async () => ({ error: null })) } } as never,
    )
  })

  it('happy path: creates the account, the membership, consumes the invite, and signs in', async () => {
    const supabase = makeSupabase()
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await expect(acceptTeamInvite(validFormData())).rejects.toThrow('REDIRECT:/ops')

    expect(supabase.state.memberships).toHaveLength(1)
    expect(supabase.state.memberships[0]).toMatchObject({
      org_id: 'org_1', user_id: NEW_USER_ID, role: 'manager',
    })
    expect(supabase.state.acceptedAt).not.toBeNull()
    expect(supabase.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('ROLLS BACK the auth account when the membership insert fails — no orphaned account, and the invite stays redeemable', async () => {
    const supabase = makeSupabase({
      membershipInsertError: { code: '23503', message: 'insert or update violates foreign key constraint' },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await acceptTeamInvite(validFormData())

    // The action surfaces a retryable error rather than redirecting.
    expect(result).toEqual({ error: 'This invitation could not be accepted. Please request a new one.' })

    // The rollback fired — this is exactly what the old
    // `return { accepted: true }` made unreachable.
    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith(NEW_USER_ID)

    // No membership was created…
    expect(supabase.state.memberships).toHaveLength(0)
    // …and the invite was released, so the invitee can try again instead of
    // being locked out by a consumed invite with nothing behind it.
    expect(supabase.state.acceptedAt).toBeNull()
  })

  it('a benign 23505 on the membership insert does NOT roll back — the membership already exists', async () => {
    const supabase = makeSupabase({
      membershipInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await expect(acceptTeamInvite(validFormData())).rejects.toThrow('REDIRECT:/ops')

    expect(supabase.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(supabase.state.acceptedAt).not.toBeNull()
  })
})
