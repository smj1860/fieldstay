import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  adminFetch:           vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  sendTeamInviteEmail: vi.fn(async () => undefined),
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { inviteTeamMember, removeMember, revokeInvite } from '@/app/(dashboard)/settings/team/actions'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient, adminFetch } from '@/lib/supabase/server'
import { sendTeamInviteEmail } from '@/lib/resend/client'
import { logAuditEvent } from '@/lib/audit'

interface QueuedByTable {
  [table: string]: unknown[]
}

// See unit/settings/settings-actions.test.ts for the pattern this mirrors.
function makeSupabase(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.gt     = (...a: unknown[]) => record('gt', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function mockAuthed(supabase: ReturnType<typeof makeSupabase>, role = 'owner') {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user: { id: USER_ID, email: 'pm@example.com' } as never,
    supabase: {} as never,
    membership: {
      org_id: ORG_ID,
      role,
      org: { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
    } as never,
  })
  vi.mocked(createServiceClient).mockReturnValue(supabase as never)
}

function fetchOkNoUser() {
  return { ok: true, json: async () => ({ users: [] }) } as unknown as Response
}

describe('settings/team/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminFetch).mockResolvedValue(fetchOkNoUser())
  })

  describe('inviteTeamMember — owner-only gate', () => {
    it('denies an admin-role caller before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'admin')

      const result = await inviteTeamMember('newperson@example.com')

      expect(result).toEqual({ error: 'Only the account owner can invite team members.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('denies a manager-role caller', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'manager')

      const result = await inviteTeamMember('newperson@example.com')

      expect(result).toEqual({ error: 'Only the account owner can invite team members.' })
    })

    it('rejects an invalid email before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'owner')

      const result = await inviteTeamMember('not-an-email')

      expect(result.error).toBeTruthy()
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await inviteTeamMember('newperson@example.com')

      expect(result).toEqual({ error: 'Failed to create invitation. Please try again.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('creates the invite scoped to the caller org_id and sends the email on the happy path', async () => {
      const supabase = makeSupabase({
        org_invites: [
          { data: null, error: null },                              // existing-pending-invite check
          { data: { token: 'tok_abc', id: 'invite_1' }, error: null }, // insert
        ],
      })
      mockAuthed(supabase, 'owner')

      const result = await inviteTeamMember('NewPerson@Example.com')

      expect(result).toEqual({ ok: true })
      const insertCall = supabase.calls.find((c) => c.table === 'org_invites' && c.method === 'insert')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inserted = insertCall!.args[0] as any
      expect(inserted.org_id).toBe(ORG_ID)
      expect(inserted.email).toBe('newperson@example.com') // normalized
      expect(inserted.role).toBe('admin')
      expect(sendTeamInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({ toEmail: 'newperson@example.com', orgName: 'Lake Martin Delivery', inviteToken: 'tok_abc' })
      )
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, actorId: USER_ID, action: 'team.member.invited' })
      )
    })

    it('rejects when the target email already belongs to an org member (checked scoped to caller org_id)', async () => {
      vi.mocked(adminFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ users: [{ id: 'existing_user_1' }] }),
      } as unknown as Response)
      const supabase = makeSupabase({
        organization_members: [{ data: { id: 'member_1' }, error: null }],
      })
      mockAuthed(supabase, 'owner')

      const result = await inviteTeamMember('existing@example.com')

      expect(result).toEqual({ error: 'This person is already a member of your organization.' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'organization_members' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(supabase.calls.some((c) => c.table === 'org_invites' && c.method === 'insert')).toBe(false)
    })

    it('rejects a duplicate pending invite', async () => {
      const supabase = makeSupabase({
        org_invites: [{ data: { id: 'invite_existing' }, error: null }],
      })
      mockAuthed(supabase, 'owner')

      const result = await inviteTeamMember('pending@example.com')

      expect(result).toEqual({ error: 'A pending invitation already exists for this email.' })
      expect(supabase.calls.some((c) => c.table === 'org_invites' && c.method === 'insert')).toBe(false)
    })
  })

  describe('removeMember — owner-only gate + IDOR/self/owner protections', () => {
    it('denies an admin-role caller before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'admin')

      const result = await removeMember('target_user_1')

      expect(result).toEqual({ error: 'Only the account owner can remove team members.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('rejects removing yourself, without touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'owner')

      const result = await removeMember(USER_ID)

      expect(result).toEqual({ error: 'You cannot remove yourself from the organization.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('rejects removing another owner — role-escalation/owner-protection guard', async () => {
      const supabase = makeSupabase({
        organization_members: [{ data: { role: 'owner' }, error: null }],
      })
      mockAuthed(supabase, 'owner')

      const result = await removeMember('other_owner_1')

      expect(result).toEqual({ error: 'Cannot remove an owner from the organization.' })
      expect(supabase.calls.some((c) => c.table === 'organization_members' && c.method === 'delete')).toBe(false)
    })

    it('scopes the target-role lookup and the delete to the caller org_id (IDOR)', async () => {
      const supabase = makeSupabase({
        organization_members: [
          { data: { role: 'manager' }, error: null }, // target role lookup
          { data: null, error: null },                 // delete
        ],
      })
      mockAuthed(supabase, 'owner')

      const result = await removeMember('target_user_1')

      expect(result).toEqual({ ok: true })
      const eqCalls = supabase.calls.filter((c) => c.table === 'organization_members' && c.method === 'eq')
      expect(eqCalls.filter((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID).length).toBeGreaterThanOrEqual(2)
      expect(eqCalls.some((c) => c.args[0] === 'user_id' && c.args[1] === 'target_user_1')).toBe(true)
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, action: 'team.member.removed', targetId: 'target_user_1' })
      )
    })
  })

  describe('revokeInvite — owner-only gate + IDOR', () => {
    it('denies a manager-role caller before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'manager')

      const result = await revokeInvite('invite_1')

      expect(result).toEqual({ error: 'Only the account owner can revoke invitations.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('scopes the delete to the caller org_id, not just the invite id', async () => {
      const supabase = makeSupabase({ org_invites: [{ data: null, error: null }] })
      mockAuthed(supabase, 'owner')

      const result = await revokeInvite('invite_other_org')

      expect(result).toEqual({ ok: true })
      const eqCalls = supabase.calls.filter((c) => c.table === 'org_invites' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'invite_other_org')).toBe(true)
    })

    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await revokeInvite('invite_1')

      expect(result).toEqual({ error: 'Failed to revoke invitation. Please try again.' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })
  })
})
