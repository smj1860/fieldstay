import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('REDIRECT:')) throw err
  },
}))
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/setup/actions'
import { ONBOARDING_STEPS } from '@/lib/onboarding-wizard'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

// This action is entirely org-scoped — every write is keyed off
// membership.org_id derived from requireOrgMember(), never a client-supplied
// id — so there is no IDOR surface here (unlike the per-property setup
// wizard actions in this batch, which all take a client-supplied propertyId).
describe('setup/actions — markStepComplete (org onboarding)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks a step complete and redirects to the given nextHref', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { onboarding_steps_completed: {} } }, { error: null }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

    await expect(markStepComplete('crew', '/setup/vendors')).rejects.toThrow('REDIRECT:/setup/vendors')
  })

  it('redirects to the next incomplete onboarding step when nextHref is omitted', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { onboarding_steps_completed: { pms: true } } }, { error: null }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

    const expectedNext = ONBOARDING_STEPS.find((s) => s.key !== 'pms' && s.key !== 'crew')

    await expect(markStepComplete('crew')).rejects.toThrow(`REDIRECT:/setup/${expectedNext?.href}`)
  })

  it('redirects to /ops once every onboarding step is complete', async () => {
    const allComplete = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.key, true]))
    const supabase = makeSupabase({
      organizations: [{ data: { onboarding_steps_completed: allComplete } }, { error: null }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

    const lastStep = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!.key

    await expect(markStepComplete(lastStep)).rejects.toThrow('REDIRECT:/ops')
  })

  it('rejects and never touches the DB when the caller is unauthenticated', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(markStepComplete('crew')).rejects.toThrow('REDIRECT:/login')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
