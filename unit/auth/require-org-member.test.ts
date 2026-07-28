import { describe, it, expect, vi, beforeEach } from 'vitest'

// redirect() in real Next.js throws an internal control-flow error and
// never returns — the mock mirrors that so callers that don't expect a
// return value after redirect() are exercised the same way.
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'

interface FakeUser {
  id: string
}

type MemberRow = Record<string, unknown>

function orgFor(name: string) {
  return {
    name, plan: 'growth', plan_status: 'active',
    max_properties: 25, trial_ends_at: null,
  }
}

/**
 * getMembershipContext() now ends its chain on .order(), not .single() — a
 * user may legitimately hold several accepted memberships, and .single()
 * errored outright on the second one.
 */
function makeSupabase(opts: {
  user:     FakeUser | null
  rows?:    MemberRow[] | null
  error?:   unknown
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = () => chain
  chain.eq     = () => chain
  chain.not    = () => chain
  chain.order  = () => Promise.resolve({ data: opts.rows ?? null, error: opts.error ?? null })

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: opts.user } }),
    },
    from: () => chain,
  }
}

function mockClient(opts: Parameters<typeof makeSupabase>[0]) {
  vi.mocked(createClient).mockResolvedValue(
    makeSupabase(opts) as unknown as Awaited<ReturnType<typeof createClient>>
  )
}

describe('requireOrgMember', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    vi.mocked(reportError).mockClear()
  })

  it('redirects to /login when there is no authenticated user', async () => {
    mockClient({ user: null })

    await expect(requireOrgMember()).rejects.toThrow('REDIRECT:/login')
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })

  it('redirects to /onboarding when the user has no accepted org membership', async () => {
    mockClient({ user: { id: 'user_1' }, rows: [] })

    await expect(requireOrgMember()).rejects.toThrow('REDIRECT:/onboarding')
    expect(mockRedirect).toHaveBeenCalledWith('/onboarding')
  })

  it('does not redirect and returns the membership when the user has an accepted membership', async () => {
    mockClient({
      user: { id: 'user_1' },
      rows: [{
        org_id: 'org_1',
        role:   'admin',
        invite_accepted_at: '2026-01-01T00:00:00Z',
        organizations: orgFor('Lake Martin Delivery'),
      }],
    })

    const result = await requireOrgMember()

    expect(mockRedirect).not.toHaveBeenCalled()
    expect(result.membership.org_id).toBe('org_1')
    expect(result.membership.role).toBe('admin')
    expect(result.membership.org.name).toBe('Lake Martin Delivery')
  })

  it('does not report anything for the ordinary single-membership case', async () => {
    mockClient({
      user: { id: 'user_1' },
      rows: [{
        org_id: 'org_1', role: 'admin',
        invite_accepted_at: '2026-01-01T00:00:00Z',
        organizations: orgFor('Lake Martin Delivery'),
      }],
    })

    await requireOrgMember()

    expect(reportError).not.toHaveBeenCalled()
  })

  // The regression this pass exists to fix: .single() returned a PGRST116
  // error rather than a row once a second accepted membership existed, the
  // error was discarded, and the user was redirected to /onboarding —
  // locked out of every org at once.
  it('resolves to the oldest membership instead of locking the user out when they hold two', async () => {
    mockClient({
      user: { id: 'user_1' },
      rows: [
        {
          org_id: 'org_old', role: 'owner',
          invite_accepted_at: '2025-03-01T00:00:00Z',
          organizations: orgFor('First Org'),
        },
        {
          org_id: 'org_new', role: 'manager',
          invite_accepted_at: '2026-06-01T00:00:00Z',
          organizations: orgFor('Second Org'),
        },
      ],
    })

    const result = await requireOrgMember()

    expect(mockRedirect).not.toHaveBeenCalled()
    expect(result.membership.org_id).toBe('org_old')
    expect(result.membership.role).toBe('owner')
    expect(result.membership.org.name).toBe('First Org')
  })

  it('reports the multi-membership case so it surfaces in Sentry rather than in a support ticket', async () => {
    mockClient({
      user: { id: 'user_1' },
      rows: [
        {
          org_id: 'org_old', role: 'owner',
          invite_accepted_at: '2025-03-01T00:00:00Z',
          organizations: orgFor('First Org'),
        },
        {
          org_id: 'org_new', role: 'manager',
          invite_accepted_at: '2026-06-01T00:00:00Z',
          organizations: orgFor('Second Org'),
        },
      ],
    })

    await requireOrgMember()

    expect(reportError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      site:  'lib.auth.getMembershipContext',
      orgId: 'org_old',
      extra: { membership_count: 2 },
    })
  })

  // A failed query and "this user has no memberships" used to be
  // indistinguishable — both silently became a redirect to /onboarding.
  it('reports a query error rather than silently treating it as "no membership"', async () => {
    mockClient({
      user:  { id: 'user_1' },
      rows:  null,
      error: { code: '500', message: 'connection reset' },
    })

    await expect(requireOrgMember()).rejects.toThrow('REDIRECT:/onboarding')
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      site: 'lib.auth.getMembershipContext',
    })
  })
})
