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

import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

interface FakeUser {
  id: string
}

function makeSupabase(opts: { user: FakeUser | null; memberRow?: Record<string, unknown> | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = () => chain
  chain.eq     = () => chain
  chain.not    = () => chain
  chain.single = () => Promise.resolve({ data: opts.memberRow ?? null })

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: opts.user } }),
    },
    from: () => chain,
  }
}

describe('requireOrgMember', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
  })

  it('redirects to /login when there is no authenticated user', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ user: null }) as unknown as Awaited<ReturnType<typeof createClient>>
    )

    await expect(requireOrgMember()).rejects.toThrow('REDIRECT:/login')
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })

  it('redirects to /onboarding when the user has no accepted org membership', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ user: { id: 'user_1' }, memberRow: null }) as unknown as Awaited<ReturnType<typeof createClient>>
    )

    await expect(requireOrgMember()).rejects.toThrow('REDIRECT:/onboarding')
    expect(mockRedirect).toHaveBeenCalledWith('/onboarding')
  })

  it('does not redirect and returns the membership when the user has an accepted membership', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({
        user: { id: 'user_1' },
        memberRow: {
          org_id: 'org_1',
          role:   'admin',
          organizations: {
            name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active',
            max_properties: 25, trial_ends_at: null,
          },
        },
      }) as unknown as Awaited<ReturnType<typeof createClient>>
    )

    const result = await requireOrgMember()

    expect(mockRedirect).not.toHaveBeenCalled()
    expect(result.membership.org_id).toBe('org_1')
    expect(result.membership.role).toBe('admin')
    expect(result.membership.org.name).toBe('Lake Martin Delivery')
  })
})
