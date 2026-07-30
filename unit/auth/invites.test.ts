import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { acceptOrgInvite } from '@/lib/auth/invites'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

// H-6: turnovers_select / bookings_select / work_orders_select grant read
// access to ANY accepted organization_members row via get_user_org_ids().
// Crew are correctly scoped to assigned turnovers only ONLY because
// /crew-invite never creates an organization_members row — accepting a
// crew-role ORG invite would silently defeat that scoping and hand a
// cleaner portfolio-wide guest PII. This suite proves acceptOrgInvite()
// refuses role='crew' while every other role still goes through normally.
//
// H-1/H-2/L-1 (2026-07-30 pre-launch audit) added the rest of this suite:
//   H-1  both writes discarded their errors and the function returned
//        { accepted: true } unconditionally — so the caller's deleteUser
//        rollback never fired and an invitee ended up with a real auth
//        account, a consumed invite, and NO membership row (locked out of
//        the org permanently).
//   H-2  load-then-decide-then-write: the SELECT filtered on
//        accepted_at IS NULL but the UPDATE was unconditional, so two
//        concurrent redemptions both "succeeded".
//   L-1  the audit metadata carried the invitee's email address.

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'update', 'insert', 'eq', 'is', 'gt'] as const) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const BASE_INVITE = {
  id:         'invite_1',
  org_id:     'org_1',
  email:      'jamie@example.com',
  expires_at: '2999-01-01T00:00:00.000Z',
}

/** org_invites call order: [0] the SELECT, [1] the atomic claim UPDATE,
 *  [2] the release UPDATE (only on a failed membership insert). */
const WON_CLAIM = { data: { id: 'invite_1' }, error: null }

describe('acceptOrgInvite — H-6 crew-role refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('refuses a crew-role org invite without inserting an organization_members row', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { ...BASE_INVITE, role: 'crew' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    expect(result).toEqual({ accepted: false })
    expect(supabase.calls.some((c) => c.table === 'organization_members' && c.method === 'insert')).toBe(false)
    expect(supabase.calls.some((c) => c.table === 'org_invites' && c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Refused crew-role org invite'))
  })

  it.each(['admin', 'manager', 'viewer'] as const)(
    'still accepts a %s-role org invite and inserts the membership',
    async (role) => {
      const supabase = makeSupabase({
        org_invites:          [{ data: { ...BASE_INVITE, role }, error: null }, WON_CLAIM],
        organization_members: [{ data: null, error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

      expect(result).toEqual({ accepted: true, orgId: 'org_1' })
      const insertCall = supabase.calls.find((c) => c.table === 'organization_members' && c.method === 'insert')
      expect(insertCall?.args[0]).toMatchObject({ org_id: 'org_1', user_id: 'user_1', role })
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.invite.accepted' }),
      )
    },
  )

  it('rejects an invite whose email does not match the authenticated user, before the role check', async () => {
    const supabase = makeSupabase({
      org_invites: [{ data: { ...BASE_INVITE, role: 'crew' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'someone-else@example.com', 'tok_1')

    expect(result).toEqual({ accepted: false })
    // Neither the crew-role log nor an audit event fires — email mismatch short-circuits first.
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('acceptOrgInvite — H-1: membership write errors must not report success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('returns accepted:false when the organization_members insert errors — this is what makes the caller\'s deleteUser rollback fire', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: { code: '23503', message: 'fk violation' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    expect(result).toEqual({ accepted: false })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('releases the invite claim when the membership insert fails, so the invitee is not permanently locked out', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: { code: '23503', message: 'fk violation' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    const updates = supabase.calls.filter((c) => c.table === 'org_invites' && c.method === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1]?.args[0]).toEqual({ accepted_at: null })
  })

  it('treats 23505 (organization_members_org_id_user_id_key) as success — the membership this invite wanted already exists', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: { code: '23505', message: 'duplicate key value' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    expect(result).toEqual({ accepted: true, orgId: 'org_1' })
    // The claim stands — no release UPDATE.
    const updates = supabase.calls.filter((c) => c.table === 'org_invites' && c.method === 'update')
    expect(updates).toHaveLength(1)
    expect(logAuditEvent).toHaveBeenCalled()
  })

  it('returns accepted:false when the invite claim UPDATE itself errors, without inserting a membership', async () => {
    const supabase = makeSupabase({
      org_invites: [
        { data: { ...BASE_INVITE, role: 'manager' }, error: null },
        { data: null, error: { code: '08006', message: 'connection failure' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    expect(result).toEqual({ accepted: false })
    expect(supabase.calls.some((c) => c.table === 'organization_members' && c.method === 'insert')).toBe(false)
  })
})

describe('acceptOrgInvite — H-2: the invite claim is atomic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('claims the invite with `.is(accepted_at, null)` in the UPDATE, not just in the earlier SELECT', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    // The claim's WHERE clause carries the precondition — the row-level guard
    // that makes two concurrent redemptions resolve to exactly one winner.
    const updateIdx = supabase.calls.findIndex((c) => c.table === 'org_invites' && c.method === 'update')
    const afterUpdate = supabase.calls.slice(updateIdx)
    expect(afterUpdate.some((c) => c.method === 'is' && c.args[0] === 'accepted_at' && c.args[1] === null)).toBe(true)
  })

  it('claims the invite BEFORE inserting the membership — an unclaimed invite must never produce a membership row', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    const claimIdx  = supabase.calls.findIndex((c) => c.table === 'org_invites' && c.method === 'update')
    const insertIdx = supabase.calls.findIndex((c) => c.table === 'organization_members' && c.method === 'insert')
    expect(claimIdx).toBeGreaterThanOrEqual(0)
    expect(insertIdx).toBeGreaterThan(claimIdx)
  })

  it('a redemption that LOSES the claim race returns accepted:false and writes nothing', async () => {
    // Zero rows matched the UPDATE — another concurrent request already set
    // accepted_at between our SELECT and our UPDATE.
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, { data: null, error: null }],
      organization_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    expect(result).toEqual({ accepted: false })
    expect(supabase.calls.some((c) => c.table === 'organization_members' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('two concurrent redemptions of the same token yield exactly one success', async () => {
    // A single shared "row" whose accepted_at only one UPDATE can transition
    // away from null — the same semantics Postgres gives the real statement.
    let acceptedAt: string | null = null

    const makeRacer = () => {
      const calls: { table: string; method: string }[] = []
      const from = vi.fn((table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {}
        let isUpdate = false
        for (const m of ['select', 'insert', 'eq', 'is', 'gt'] as const) {
          chain[m] = () => { calls.push({ table, method: m }); return chain }
        }
        chain.update = () => { calls.push({ table, method: 'update' }); isUpdate = true; return chain }

        const resolve = async () => {
          if (table === 'org_invites' && !isUpdate) {
            return { data: { ...BASE_INVITE, role: 'manager' }, error: null }
          }
          if (table === 'org_invites' && isUpdate) {
            // Yield first, so both racers have passed the SELECT before
            // either one attempts the claim.
            await Promise.resolve()
            if (acceptedAt !== null) return { data: null, error: null }
            acceptedAt = new Date().toISOString()
            return { data: { id: BASE_INVITE.id }, error: null }
          }
          return { data: null, error: null }
        }

        chain.single      = () => resolve()
        chain.maybeSingle = () => resolve()
        chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          resolve().then(res, rej)
        return chain
      })
      return { from, calls }
    }

    const a = makeRacer()
    const b = makeRacer()
    const clients = [a, b]
    let n = 0
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockImplementation(() => clients[n++])

    const [r1, r2] = await Promise.all([
      acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1'),
      acceptOrgInvite('user_2', 'jamie@example.com', 'tok_1'),
    ])

    expect([r1.accepted, r2.accepted].filter(Boolean)).toHaveLength(1)

    // And only the winner created a membership row.
    const memberInserts = [...a.calls, ...b.calls]
      .filter((c) => c.table === 'organization_members' && c.method === 'insert')
    expect(memberInserts).toHaveLength(1)
  })
})

describe('acceptOrgInvite — L-1: no PII in audit metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('does not put the invitee\'s email address in audit_events.metadata', async () => {
    const supabase = makeSupabase({
      org_invites:          [{ data: { ...BASE_INVITE, role: 'manager' }, error: null }, WON_CLAIM],
      organization_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

    const call = vi.mocked(logAuditEvent).mock.calls[0]?.[0] as
      { actorId: string; metadata?: Record<string, unknown> }
    expect(JSON.stringify(call.metadata ?? {})).not.toContain('jamie@example.com')
    expect(call.metadata).toEqual({ role: 'manager' })
    // actorId is what identifies the user — no email needed.
    expect(call.actorId).toBe('user_1')
  })
})
