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
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgRole } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
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
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

/** organizations read succeeds, then the UPDATE returns the row it wrote. */
function okQueue(completed: Record<string, boolean> = {}) {
  return {
    organizations: [
      { data: { onboarding_steps_completed: completed } },
      { data: { id: 'org_1' }, error: null },
    ],
  }
}

// This action is entirely org-scoped — every write is keyed off
// membership.org_id derived from the auth helper, never a client-supplied
// id — so there is no IDOR surface here (unlike the per-property setup
// wizard actions in this batch, which all take a client-supplied propertyId).
describe('setup/actions — markStepComplete (org onboarding)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks a step complete and redirects to the given nextHref', async () => {
    const supabase = makeSupabase(okQueue())
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await expect(markStepComplete('crew', '/setup/vendors')).rejects.toThrow('REDIRECT:/setup/vendors')
  })

  it('redirects to the next incomplete onboarding step when nextHref is omitted', async () => {
    const supabase = makeSupabase(okQueue({ pms: true }))
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    const expectedNext = ONBOARDING_STEPS.find((s) => s.key !== 'pms' && s.key !== 'crew')

    await expect(markStepComplete('crew')).rejects.toThrow(`REDIRECT:/setup/${expectedNext?.href}`)
  })

  it('redirects to /ops once every onboarding step is complete', async () => {
    const allComplete = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.key, true]))
    const supabase = makeSupabase(okQueue(allComplete))
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    const lastStep = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!.key

    await expect(markStepComplete(lastStep)).rejects.toThrow('REDIRECT:/ops')
  })

  it('rejects and never touches the DB when the caller is unauthenticated', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgRole).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(markStepComplete('crew')).rejects.toThrow('REDIRECT:/login')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // ── The defect this action shipped with ────────────────────────────────────
  //
  // organizations' RLS UPDATE policy is is_org_member(id, ARRAY['admin']) —
  // admin and owner, nobody else. The action ran under requireOrgMember() (any
  // member) and DISCARDED the update result. An RLS-denied UPDATE is not an
  // error; it simply matches zero rows. So a manager clicking "Continue" got
  // no error, no log, and a redirect to the next step — while nothing was
  // saved. /setup recomputes the current step from the database, so they were
  // sent back to step one every time, on all eight steps.
  //
  // app/(dashboard)/layout.tsx force-redirects members of an org with zero
  // completed steps to /setup, so a manager invited before the owner finished
  // step 1 was pinned there with no way out. That layout gate and the sidebar
  // link are now role-aware too; this pins the action's own half.
  it('throws instead of redirecting when the UPDATE matches no row (RLS denial)', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { onboarding_steps_completed: {} } },
        { data: null, error: null },   // denied by RLS: no error, no row
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await expect(markStepComplete('crew', '/setup/vendors'))
      .rejects.toThrow(/Could not save your setup progress/)
    // The redirect is the part that made this invisible — it made a failed
    // save look exactly like a successful one.
    expect(mockRedirect).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalled()
  })

  it('asks for the admin role, matching the RLS policy exactly', async () => {
    const supabase = makeSupabase(okQueue())
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await expect(markStepComplete('crew', '/setup/vendors')).rejects.toThrow('REDIRECT:/setup/vendors')

    // requireOrgRole passes 'owner' unconditionally, so ['admin'] here is the
    // same set is_org_member(id, ARRAY['admin']) admits.
    expect(requireOrgRole).toHaveBeenCalledWith(['admin'])
  })

  it('refuses a caller whose role cannot write the org row', async () => {
    const supabase = makeSupabase(okQueue())
    vi.mocked(requireOrgRole).mockRejectedValue(
      new Error('You do not have permission to perform this action.')
    )

    await expect(markStepComplete('crew', '/setup/vendors')).rejects.toThrow(/permission/)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('throws instead of redirecting when the progress read fails', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: null, error: { code: '42501', message: 'permission denied' } }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

    await expect(markStepComplete('crew', '/setup/vendors'))
      .rejects.toThrow(/Could not load your setup progress/)
    expect(mockRedirect).not.toHaveBeenCalled()
  })
})
