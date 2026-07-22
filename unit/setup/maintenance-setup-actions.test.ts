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
import { logAuditEvent } from '@/lib/audit'
import {
  addMaintenanceSchedule,
  deleteMaintenanceSchedule,
  completeMaintenanceStep,
  cloneMaintenanceFromProperty,
} from '@/app/(dashboard)/properties/[id]/setup/maintenance/actions'

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

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('properties/[id]/setup/maintenance/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addMaintenanceSchedule', () => {
    function scheduleFd(fields: Record<string, string> = {}) {
      return fd({ name: 'HVAC filter change', schedule_type: 'routine', frequency: 'quarterly', ...fields })
    }

    it('creates a schedule once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: 'prop_1' } }],
        maintenance_schedules:  [{ data: { id: 'sched_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addMaintenanceSchedule('prop_1', null, scheduleFd())

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'maintenance_schedule.created' }))
    })

    // Regression test — addMaintenanceSchedule previously inserted a
    // maintenance_schedules row using the caller's org_id but a
    // client-supplied propertyId that was never verified to belong to that
    // org. See CLAUDE.md's IDOR standing-audit item; fixed in this session
    // by adding the same ownership check used throughout this setup-wizard
    // file set.
    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addMaintenanceSchedule('other-orgs-property', null, scheduleFd())

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('rejects when the schedule name is missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addMaintenanceSchedule('prop_1', null, scheduleFd({ name: '' }))

      expect(result).toEqual({ error: 'Schedule name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addMaintenanceSchedule('prop_1', null, scheduleFd())

      expect(result).toEqual({ error: 'Failed to save schedule. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteMaintenanceSchedule', () => {
    it('deletes a schedule scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(deleteMaintenanceSchedule('sched_1', 'prop_1')).resolves.toBeUndefined()

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'maintenance_schedule.deleted' }))
    })

    it('throws when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(deleteMaintenanceSchedule('sched_1', 'prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('completeMaintenanceStep', () => {
    it('marks the maintenance step complete and redirects to the crew step', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: {} } }, { error: null }],
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

  describe('cloneMaintenanceFromProperty', () => {
    it('copies non-duplicate schedules to a target property verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_2' } }],
        maintenance_schedules: [
          { data: [{ name: 'Gutter cleaning', description: null, schedule_type: 'routine', frequency: 'monthly', month_due: null, day_of_month_due: null, estimated_cost: null, instructions: null, auto_create_wo: true, assigned_vendor_id: null }] },
          { data: [] },
          { error: null },
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneMaintenanceFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 1, skipped: 0 })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.maintenance.cloned' }))
    })

    // Regression test — cloneMaintenanceFromProperty previously read the
    // existing-schedules check scoped by org_id (so it silently found
    // nothing for a foreign property) but then inserted new rows using the
    // client-supplied targetPropertyId regardless, without ever verifying
    // that id belonged to the caller's org. See CLAUDE.md's IDOR
    // standing-audit item; fixed in this session.
    it('rejects a target property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneMaintenanceFromProperty('prop_1', 'other-orgs-property')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Target property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
    })

    it('errors when the source has no active schedules', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: 'prop_2' } }],
        maintenance_schedules:  [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneMaintenanceFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Source has no schedules' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await cloneMaintenanceFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
