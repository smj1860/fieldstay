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
    chain.select = (...a: unknown[]) => record('select', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.gt     = (...a: unknown[]) => record('gt', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
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
        org_invites:          [{ data: { ...BASE_INVITE, role }, error: null }],
        organization_members: [{ data: null, error: null }], // no existing membership
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await acceptOrgInvite('user_1', 'jamie@example.com', 'tok_1')

      expect(result).toEqual({ accepted: true, orgId: 'org_1' })
      const insertCall = supabase.calls.find((c) => c.table === 'organization_members' && c.method === 'insert')
      expect(insertCall?.args[0]).toMatchObject({ org_id: 'org_1', user_id: 'user_1', role })
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.invite.accepted', metadata: { email: 'jamie@example.com', role } }),
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
