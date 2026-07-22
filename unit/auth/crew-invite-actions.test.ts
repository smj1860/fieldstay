import { describe, it, expect, vi, beforeEach } from 'vitest'

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
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { activateCrewAccount } from '@/app/crew-invite/[token]/actions'
import { createServiceClient, createClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { inviteAcceptRatelimit } from '@/lib/rate-limit'

function makeSupabase(crewLookup: { data: unknown; error?: unknown }, updateResult: { data?: unknown; error?: unknown } = { error: null }) {
  const update = vi.fn(() => chain)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = () => chain
  chain.eq     = () => chain
  chain.is     = () => chain
  chain.single = () => Promise.resolve(crewLookup)
  chain.update  = update
  chain.then    = (resolve: (v: unknown) => unknown) => Promise.resolve(updateResult).then(resolve)

  const from = vi.fn(() => chain)

  const auth = {
    admin: {
      createUser: vi.fn(async () => ({ data: { user: { id: 'new_user_1' } }, error: null })),
      deleteUser: vi.fn(async () => undefined),
    },
  }

  return { from, auth, update }
}

const VALID_TOKEN = '22222222-2222-2222-2222-222222222222'
const CREW_ID     = '11111111-1111-1111-1111-111111111111'

function validFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData()
  fd.set('token', VALID_TOKEN)
  fd.set('crewId', CREW_ID)
  fd.set('password', 'supersecret123')
  fd.set('confirm', 'supersecret123')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

describe('crew-invite/[token]/actions — activateCrewAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(inviteAcceptRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('rejects mismatched password/confirm before touching the DB', async () => {
    const supabase = makeSupabase({ data: null })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData({ confirm: 'different123' }))

    expect(result.error).toBe('Passwords do not match')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rate-limits repeated attempts before touching the DB', async () => {
    vi.mocked(inviteAcceptRatelimit.limit).mockResolvedValue({ success: false } as never)
    const supabase = makeSupabase({ data: null })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'Too many attempts. Please try again in a few minutes.' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an invalid token/crewId combination (no matching row)', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'Invalid invite link' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('rejects a token that is already used (user_id already set)', async () => {
    const supabase = makeSupabase({
      data: {
        id: CREW_ID, name: 'Jamie', email: 'jamie@example.com', org_id: 'org_1',
        user_id: 'already_linked_user', invite_accepted_at: null, invite_token: VALID_TOKEN, invite_sent_at: null,
      },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'This invite has already been used' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('rejects a token that is already used (invite_accepted_at already set)', async () => {
    const supabase = makeSupabase({
      data: {
        id: CREW_ID, name: 'Jamie', email: 'jamie@example.com', org_id: 'org_1',
        user_id: null, invite_accepted_at: '2026-01-01T00:00:00Z', invite_token: VALID_TOKEN, invite_sent_at: null,
      },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'This invite has already been used' })
  })

  it('rejects an expired invite link (invite_sent_at older than 7 days)', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()
    const supabase = makeSupabase({
      data: {
        id: CREW_ID, name: 'Jamie', email: 'jamie@example.com', org_id: 'org_1',
        user_id: null, invite_accepted_at: null, invite_token: VALID_TOKEN, invite_sent_at: eightDaysAgo,
      },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'This invite link has expired. Ask your manager to send a new one.' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('requires a submitted email when the crew record has none on file', async () => {
    const supabase = makeSupabase({
      data: {
        id: CREW_ID, name: 'Jamie', email: null, org_id: 'org_1',
        user_id: null, invite_accepted_at: null, invite_token: VALID_TOKEN, invite_sent_at: null,
      },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'Enter an email address to finish setting up your account' })
    expect(supabase.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('creates the account, links it to the crew record, and signs in on the happy path', async () => {
    const supabase = makeSupabase(
      {
        data: {
          id: CREW_ID, name: 'Jamie', email: 'jamie@example.com', org_id: 'org_1',
          user_id: null, invite_accepted_at: null, invite_token: VALID_TOKEN, invite_sent_at: null,
        },
      },
      { error: null }
    )
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const signInWithPassword = vi.fn(async () => ({ error: null }))
    vi.mocked(createClient).mockResolvedValue({ auth: { signInWithPassword } } as never)

    await expect(activateCrewAccount(validFormData())).rejects.toThrow('REDIRECT:/crew/install')

    expect(supabase.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jamie@example.com' })
    )
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'new_user_1' })
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', action: 'crew.account.activated', targetId: CREW_ID })
    )
    expect(mockRedirect).toHaveBeenCalledWith('/crew/install')
  })

  it('deletes the newly created auth user when linking the crew record fails (no orphaned account)', async () => {
    const supabase = makeSupabase(
      {
        data: {
          id: CREW_ID, name: 'Jamie', email: 'jamie@example.com', org_id: 'org_1',
          user_id: null, invite_accepted_at: null, invite_token: VALID_TOKEN, invite_sent_at: null,
        },
      },
      { error: { message: 'update failed' } }
    )
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await activateCrewAccount(validFormData())

    expect(result).toEqual({ error: 'Failed to activate account. Please try again.' })
    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('new_user_1')
  })
})
