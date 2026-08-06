import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
// Pulled in transitively via properties/actions.ts's markStepComplete ->
// lib/checklists/apply-master-template.ts.
vi.mock('server-only', () => ({}))

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
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
// Pulled in transitively via properties/actions.ts's markStepComplete, used
// by completeMaintenanceStep — not under test in this file.
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { completeMaintenanceStep } from '@/app/(dashboard)/properties/[id]/setup/maintenance/actions'

import { setupStepRpcStub } from '@/unit/stubs/setup-step-rpc'

// ============================================================================
// This file used to cover addMaintenanceSchedule, deleteMaintenanceSchedule
// and cloneMaintenanceFromProperty as well. All three were deleted — see the
// header comment on the action file for why each one was a divergent
// duplicate of a live action rather than a feature.
//
// Their tests went with them deliberately. Every one of them passed against
// code nothing could reach, which is precisely the failure mode
// unreferenced-server-actions.test.ts exists to catch: a green suite is not
// evidence that an action is wired up, and keeping the tests would have left
// the impression that it was.
// ============================================================================

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    // markStepComplete (pulled in transitively) now reads its UPDATE back with
    // .select('id').maybeSingle() so a 0-row RLS denial can't look like success.
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const rpc = setupStepRpcStub()
  return { from, rpc }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('properties/[id]/setup/maintenance/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('completeMaintenanceStep', () => {
    it('marks the maintenance step complete and redirects to the crew step', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: {} } }, { data: { id: 'prop_1' }, error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(completeMaintenanceStep('prop_1'))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/crew')
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(completeMaintenanceStep('prop_1')).rejects.toThrow('REDIRECT:/login')
    })
  })
})
