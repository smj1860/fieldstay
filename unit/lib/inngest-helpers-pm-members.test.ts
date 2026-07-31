import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAdminFetch } = vi.hoisted(() => ({ mockAdminFetch: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  adminFetch: mockAdminFetch,
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { getPmMembers, getPmMembersByOrgIds, getPmEmailsByOrgIds } from '@/lib/inngest/helpers'

type MemberRow = { org_id: string; user_id: string; role: string }

/**
 * Minimal organization_members query stub. Records the filters applied so
 * the tests can assert the invite_accepted_at guard is still there, and
 * resolves to the supplied rows.
 */
function makeSupabase(rows: MemberRow[], userEmails: Record<string, string | null> = {}) {
  const filters: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  const record = (method: string, args: unknown[]) => {
    filters.push({ method, args })
    return chain
  }
  chain.select = (...a: unknown[]) => record('select', a)
  chain.in     = (...a: unknown[]) => record('in', a)
  chain.not    = (...a: unknown[]) => record('not', a)
  chain.then   = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve)

  const getUserById = vi.fn(async (id: string) => {
    const email = id in userEmails ? userEmails[id] : `${id}@example.com`
    return { data: { user: email ? { id, email } : null }, error: null }
  })

  return {
    from: vi.fn(() => chain),
    auth: { admin: { getUserById } },
    filters,
    getUserById,
  }
}

const ORG = 'org_1'

describe('getPmMembers / getPmMembersByOrgIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sorts owner → admin → manager and applies the limit AFTER sorting', async () => {
    // Deliberately returned in the "wrong" order: an unordered
    // .limit(1) on this set is exactly the nondeterminism that made the
    // vendor-facing dispatcher name inconsistent before the 2026-07-30 audit.
    const supabase = makeSupabase([
      { org_id: ORG, user_id: 'u_manager', role: 'manager' },
      { org_id: ORG, user_id: 'u_admin',   role: 'admin' },
      { org_id: ORG, user_id: 'u_owner',   role: 'owner' },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await getPmMembers(supabase as any, ORG, { roles: ['owner', 'admin', 'manager'] })
    expect(all.map((m) => m.userId)).toEqual(['u_owner', 'u_admin', 'u_manager'])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const one = await getPmMembers(supabase as any, ORG, { roles: ['owner', 'admin', 'manager'], limit: 1 })
    expect(one.map((m) => m.userId)).toEqual(['u_owner'])
  })

  it('only considers invite-accepted members', async () => {
    const supabase = makeSupabase([{ org_id: ORG, user_id: 'u1', role: 'owner' }])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getPmMembers(supabase as any, ORG)

    expect(supabase.filters).toContainEqual({
      method: 'not',
      args:   ['invite_accepted_at', 'is', null],
    })
  })

  it('drops a member whose email cannot be resolved rather than returning a blank address', async () => {
    const supabase = makeSupabase(
      [
        { org_id: ORG, user_id: 'u_owner', role: 'owner' },
        { org_id: ORG, user_id: 'u_admin', role: 'admin' },
      ],
      { u_owner: null },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const members = await getPmMembers(supabase as any, ORG)
    expect(members.map((m) => m.userId)).toEqual(['u_admin'])
  })

  it('batches many orgs into ONE organization_members query and applies the limit per org', async () => {
    const supabase = makeSupabase([
      { org_id: 'org_a', user_id: 'a_manager', role: 'manager' },
      { org_id: 'org_a', user_id: 'a_owner',   role: 'owner' },
      { org_id: 'org_b', user_id: 'b_admin',   role: 'admin' },
    ])

    const byOrg = await getPmMembersByOrgIds(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ['org_a', 'org_b', 'org_a'],   // duplicate is deduped
      { roles: ['owner', 'admin', 'manager'], limit: 1 },
    )

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(byOrg.get('org_a')?.map((m) => m.userId)).toEqual(['a_owner'])
    expect(byOrg.get('org_b')?.map((m) => m.userId)).toEqual(['b_admin'])
  })

  it('resolves emails via ONE paged Admin-API sweep instead of a getUserById per user', async () => {
    // Six users — past the threshold where a single list sweep beats
    // per-user lookups. At 150 orgs the per-user shape is ~300 sequential
    // GoTrue round-trips; this is the whole point of the batched form.
    const rows: MemberRow[] = Array.from({ length: 6 }, (_, i) => ({
      org_id:  `org_${i}`,
      user_id: `u${i}`,
      role:    'owner',
    }))
    const supabase = makeSupabase(rows)

    mockAdminFetch.mockResolvedValue({
      ok:   true,
      json: async () => ({ users: rows.map((r) => ({ id: r.user_id, email: `${r.user_id}@example.com` })) }),
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byOrg = await getPmMembersByOrgIds(supabase as any, rows.map((r) => r.org_id))

    expect(supabase.getUserById).not.toHaveBeenCalled()
    expect(mockAdminFetch).toHaveBeenCalledTimes(1)
    expect(mockAdminFetch.mock.calls[0][0]).toContain('/auth/v1/admin/users?page=1')
    // The Admin call is itself bounded — nothing in a cron may hang forever.
    expect((mockAdminFetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    expect(byOrg.size).toBe(6)
  })

  it('throws rather than silently returning a partial batch when the Admin API errors', async () => {
    const rows: MemberRow[] = Array.from({ length: 6 }, (_, i) => ({
      org_id: `org_${i}`, user_id: `u${i}`, role: 'owner',
    }))
    mockAdminFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPmMembersByOrgIds(makeSupabase(rows) as any, rows.map((r) => r.org_id)),
    ).rejects.toThrow(/admin\/users/)
  })

  it('getPmEmailsByOrgIds returns the highest-preference PM per org', async () => {
    const supabase = makeSupabase([
      { org_id: 'org_a', user_id: 'a_admin', role: 'admin' },
      { org_id: 'org_a', user_id: 'a_owner', role: 'owner' },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = await getPmEmailsByOrgIds(supabase as any, ['org_a'])
    expect(emails.get('org_a')).toBe('a_owner@example.com')
  })
})
