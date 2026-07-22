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
// by saveDetails on success — not under test in this file.
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { saveDetails } from '@/app/(dashboard)/properties/[id]/setup/details/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }))
  return { from, rpc, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function fd(fields: Record<string, string> = {}) {
  const f = new FormData()
  f.append('name', 'Lakeview Cottage')
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

// A pristine existing row (no guest-access fields set) so the
// "guestAccessChanged" branch doesn't fire unless a test opts in.
function pristineExisting() {
  return { wifi_password: null, door_code_secret_id: null, internal_notes: null }
}

describe('properties/[id]/setup/details/actions — saveDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves details, marks the step complete, and redirects to the ical step', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: pristineExisting() },
        { error: null },
        { data: { setup_steps_completed: {} } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await expect(saveDetails('prop_1', null, fd()))
      .rejects.toThrow('REDIRECT:/properties/prop_1/setup/ical')

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.rates.updated' }))
  })

  it('rejects when the property name is missing', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    const emptyForm = new FormData()
    const result = await saveDetails('prop_1', null, emptyForm)

    expect(result).toEqual({ error: 'Property name is required' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('scopes the update to the caller org, not just the property id (IDOR check)', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: pristineExisting() },
        { error: null },
        { data: { setup_steps_completed: {} } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await expect(saveDetails('other-orgs-property', null, fd())).rejects.toThrow('REDIRECT:')

    const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('logs an extra guest-access audit entry when the door code changes, without leaking its value', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: pristineExisting() },
        { error: null },
        { data: { setup_steps_completed: {} } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await expect(saveDetails('prop_1', null, fd({ door_code: '4821' }))).rejects.toThrow('REDIRECT:')

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action:   'property.updated',
      metadata: { change: 'guest_access_details' },
    }))
    // The raw door code must never appear in audit metadata.
    for (const call of vi.mocked(logAuditEvent).mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('4821')
    }
  })

  it('does not log a guest-access audit entry when nothing guest-related changed', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: pristineExisting() },
        { error: null },
        { data: { setup_steps_completed: {} } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgMember).mockResolvedValue({
      supabase, membership, user: { id: 'user_1' },
    } as never)

    await expect(saveDetails('prop_1', null, fd())).rejects.toThrow('REDIRECT:')

    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: { change: 'guest_access_details' },
    }))
  })

  it('rejects and never touches the DB when the caller is unauthenticated', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(saveDetails('prop_1', null, fd())).rejects.toThrow('REDIRECT:/login')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
