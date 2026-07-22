import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { saveMasterMaintenanceSchedules } from '@/app/(dashboard)/setup/maintenance-template/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

// This action is entirely org-scoped (org_master_maintenance_schedules rows
// keyed off membership.org_id, no client-supplied id referencing another
// org's row), so there is no IDOR surface here — unlike the per-property
// setup wizard actions in this batch.
describe('setup/maintenance-template/actions — saveMasterMaintenanceSchedules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const items = [{
    title: 'HVAC filter change', description: null, frequency: 'quarterly',
    specialty: 'hvac', estimated_cost: null,
  }]

  it('deactivates the previous master list and inserts the new one, scoped to the caller org', async () => {
    const supabase = makeSupabase({
      org_master_maintenance_schedules: [{ error: null }, { error: null }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    const result = await saveMasterMaintenanceSchedules(items)

    expect(result).toEqual({ saved: 1 })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', action: 'maintenance.template.updated', metadata: { saved: 1 },
    }))
    const eqCalls = supabase.calls.filter((c) => c.table === 'org_master_maintenance_schedules' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('deactivates the previous list without inserting when given an empty list', async () => {
    const supabase = makeSupabase({
      org_master_maintenance_schedules: [{ error: null }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    const result = await saveMasterMaintenanceSchedules([])

    expect(result).toEqual({ saved: 0 })
    expect(supabase.calls.some((c) => c.table === 'org_master_maintenance_schedules' && c.method === 'insert')).toBe(false)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: { saved: 0 } }))
  })

  it('returns an error when the insert fails', async () => {
    const supabase = makeSupabase({
      org_master_maintenance_schedules: [{ error: null }, { error: { message: 'db error' } }],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    const result = await saveMasterMaintenanceSchedules(items)

    expect(result).toEqual({ error: 'Operation failed. Please try again.', saved: 0 })
  })

  it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    const result = await saveMasterMaintenanceSchedules(items)

    expect(result).toEqual({ error: 'Operation failed. Please try again.', saved: 0 })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
