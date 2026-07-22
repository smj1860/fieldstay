import { describe, it, expect, vi, beforeEach } from 'vitest'

// redirect() in real Next.js throws an internal control-flow error and
// never returns — mirror that so callers that don't expect a return value
// after redirect() are exercised the same way. See
// unit/auth/require-org-member.test.ts for the same pattern.
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}))
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}))
vi.mock('@/lib/rate-limit', () => ({
  inviteAcceptRatelimit: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient:         vi.fn(),
  adminFetch:           vi.fn(),
}))
vi.mock('@/lib/auth/invites', () => ({
  acceptOrgInvite: vi.fn(),
}))

import { acceptTeamInvite } from '@/app/accept-invite/[token]/actions'
import { createServiceClient, createClient, adminFetch } from '@/lib/supabase/server'
import { acceptOrgInvite } from '@/lib/auth/invites'
import { inviteAcceptRatelimit } from '@/lib/rate-limit'

interface QueuedByTable {
  [table: string]: unknown[]
}

function makeSupabase(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.is     = () => chain
    chain.gt     = () => chain
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.single = () => resolveNext()
    return chain
  })

  const auth = {
    admin: {
      createUser: vi.fn(async () => ({ data: { user: { id: 'new_user_1' } }, error: null })),
      deleteUser: vi.fn(async () => undefined),
    },
  }

  return { from, auth }
}

const VALID_TOKEN = '11111111-1111-1111-1111-111111111111'

function validFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData()
  fd.set('token', VALID_TOKEN)
  fd.set('fullName', 'Jamie Rivera')
  fd.set('password', 'supersecret123')
  fd.set('confirm', 'supersecret123')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

function fetchNoExistingUser() {
  return { ok: true, json: async () => ({ users: [] }) } as unknown as Response
}

describe('accept-invite/[token]/actions — acceptTeamInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(inviteAcceptRatelimit.limit).mockResolvedValue({ success: true } as never)
    vi.mocked(adminFetch).mockResolvedValue(fetchNoExistingUser())
  })

  it('rejects an invalid (non-UUID) token before touching the DB', async () => {
    const supabase = makeSupabase()
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await acceptTeamInvite(validFormData({ token: 'not-a-uuid' }))

    expect(result.error).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects mismatched password/confirm before touching the DB', async () => {
    const supabase = makeSupabase()
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await acceptTeamInvite(validFormData({ confirm: 'somethingElse123' }))

    expect(result.error).toBe('Passwords do not match')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rate-limits repeated attempts before touching the DB', async () => {
    vi.mocked(inviteAcceptRatelimit.limit).mockResolvedValue({ success: false } as never)
    const supabase = makeSupabase()
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await acceptTeamInvite(validFormData())

    expect(result).toEqual({ error: 'Too many attempts. Please try again in a few minutes.' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an expired or already-used invite token', async () => {
    const supabase = makeSupabase({ org_invites: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await acceptTeamInvite(validFormData())

    expect(result).toEqual({ error: 'This invitation is no longer valid.' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('rejects when an account with the invite email already exists — no duplicate auth.users row created', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { id: 'invite_1', email: 'jamie@example.com', role: 'admin', org_id: 'org_1', expires_at: '2999-01-01' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(adminFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ users: [{ id: 'existing_user_1' }] }),
    } as unknown as Response)

    const result = await acceptTeamInvite(validFormData())

    expect(result).toEqual({ error: 'An account with this email already exists. Please log in instead.' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('creates the account and accepts the invite on the happy path, then redirects to /ops', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { id: 'invite_1', email: 'jamie@example.com', role: 'admin', org_id: 'org_1', expires_at: '2999-01-01' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: true, orgId: 'org_1' })
    const signInWithPassword = vi.fn(async () => ({ error: null }))
    vi.mocked(createClient).mockResolvedValue({ auth: { signInWithPassword } } as never)

    await expect(acceptTeamInvite(validFormData())).rejects.toThrow('REDIRECT:/ops')

    expect(supabase.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jamie@example.com', password: 'supersecret123' })
    )
    expect(acceptOrgInvite).toHaveBeenCalledWith('new_user_1', 'jamie@example.com', VALID_TOKEN)
    expect(mockRedirect).toHaveBeenCalledWith('/ops')
  })

  it('deletes the newly created auth user when acceptOrgInvite fails to attach the membership (no orphaned account)', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { id: 'invite_1', email: 'jamie@example.com', role: 'admin', org_id: 'org_1', expires_at: '2999-01-01' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: false })

    const result = await acceptTeamInvite(validFormData())

    expect(result).toEqual({ error: 'This invitation could not be accepted. Please request a new one.' })
    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('new_user_1')
  })

  it('redirects to /login when auto-sign-in fails after successful account creation', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { id: 'invite_1', email: 'jamie@example.com', role: 'admin', org_id: 'org_1', expires_at: '2999-01-01' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(acceptOrgInvite).mockResolvedValue({ accepted: true, orgId: 'org_1' })
    const signInWithPassword = vi.fn(async () => ({ error: { message: 'sign-in failed' } }))
    vi.mocked(createClient).mockResolvedValue({ auth: { signInWithPassword } } as never)

    await expect(acceptTeamInvite(validFormData())).rejects.toThrow('REDIRECT:/login')
  })
})
