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
  // saveDetails is now role-gated (admin|manager, owner passes automatically)
  // because it writes properties AND the Vault door code. markStepComplete,
  // pulled in transitively, still uses requireOrgMember.
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
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

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
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
    chain.single      = vi.fn(() => Promise.resolve(result))
    // Both UPDATEs in this flow (saveDetails' own, and markStepComplete's) now
    // read the touched row back so a 0-row RLS denial can't look like success.
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }))
  return { from, rpc, calls }
}

// The `properties` response queue for a fully successful saveDetails:
//   1. existing-row SELECT
//   2. the details UPDATE, read back  → must return a row
//   3. markStepComplete's SELECT
//   4. markStepComplete's UPDATE, read back → must return a row
function happyPropertiesQueue(): Resp[] {
  return [
    { data: pristineExisting() },
    { data: { id: 'prop_1' }, error: null },
    { data: { setup_steps_completed: {} } },
    { data: { id: 'prop_1' }, error: null },
  ]
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

// saveDetails gates on requireOrgRole; markStepComplete (called on success)
// still gates on requireOrgMember — both must resolve for the happy path.
function mockAuthed(supabase: ReturnType<typeof makeSupabase>, role: 'admin' | 'manager' | 'owner' | 'viewer' = 'admin') {
  const ctx = { supabase, membership: { ...membership, role }, user: { id: 'user_1' } }
  vi.mocked(requireOrgMember).mockResolvedValue(ctx as never)
  vi.mocked(requireOrgRole).mockResolvedValue(ctx as never)
}

describe('properties/[id]/setup/details/actions — saveDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves details, marks the step complete, and redirects to the ical step', async () => {
    const supabase = makeSupabase({
      properties: happyPropertiesQueue(),
    })
    mockAuthed(supabase)

    await expect(saveDetails('prop_1', null, fd()))
      .rejects.toThrow('REDIRECT:/properties/prop_1/setup/ical')

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.rates.updated' }))
  })

  it('rejects when the property name is missing', async () => {
    const supabase = makeSupabase({})
    mockAuthed(supabase)

    const emptyForm = new FormData()
    const result = await saveDetails('prop_1', null, emptyForm)

    expect(result).toEqual({ error: 'Property name is required' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('scopes the update to the caller org, not just the property id (IDOR check)', async () => {
    const supabase = makeSupabase({
      properties: happyPropertiesQueue(),
    })
    mockAuthed(supabase)

    await expect(saveDetails('other-orgs-property', null, fd())).rejects.toThrow('REDIRECT:')

    const eqCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  it('logs an extra guest-access audit entry when the door code changes, without leaking its value', async () => {
    const supabase = makeSupabase({
      properties: happyPropertiesQueue(),
    })
    mockAuthed(supabase)

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
      properties: happyPropertiesQueue(),
    })
    mockAuthed(supabase)

    await expect(saveDetails('prop_1', null, fd())).rejects.toThrow('REDIRECT:')

    expect(logAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      metadata: { change: 'guest_access_details' },
    }))
  })

  // ── Regressions from the 2026-07-31 audit ──────────────────────────────
  // A `viewer` used to reach this action through requireOrgMember. The
  // properties UPDATE was denied by RLS (0 rows, NO error), so the action
  // reported success — and then still called store_property_door_code, whose
  // own guard was org membership in ANY role, so the door code was overwritten.

  it('refuses the save when the caller lacks the admin|manager role', async () => {
    const supabase = makeSupabase({ properties: happyPropertiesQueue() })
    vi.mocked(requireOrgRole).mockRejectedValue(
      new Error('You do not have permission to perform this action.')
    )

    const result = await saveDetails('prop_1', null, fd({ door_code: '4821' }))

    expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('reports a permission failure — and never writes the door code — when the update matches 0 rows', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: pristineExisting() },
        { data: null, error: null }, // RLS-denied UPDATE: 0 rows, no error
      ],
    })
    mockAuthed(supabase)

    const result = await saveDetails('prop_1', null, fd({ door_code: '4821' }))

    expect(result.error).toContain('permission')
    expect(result.success).toBeUndefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('surfaces a door-code write failure instead of reporting a successful save', async () => {
    const supabase = makeSupabase({ properties: happyPropertiesQueue() })
    mockAuthed(supabase)
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'vault down' } } as never)

    const result = await saveDetails('prop_1', null, fd({ door_code: '4821' }))

    expect(result).toEqual({ error: 'Operation failed. Please try again.' })
  })

  // The page used to DISCARD read_property_door_code's error, so a failed
  // decrypt rendered the door-code input blank. Submitting that render sent an
  // empty door_code, which coerces to null, which drives
  // store_property_door_code's NULL branch — DELETE the vault secret and null
  // door_code_secret_id. A transient read failure plus any later save (even one
  // only renaming the property) permanently destroyed a physical-access
  // credential, silently. details-form now disables the field and sends
  // door_code_unchanged=1 on that render; these pin both halves.
  describe('door_code_unchanged (failed-decrypt render must not clear the code)', () => {
    it('skips the door-code write entirely rather than clearing it', async () => {
      const supabase = makeSupabase({ properties: happyPropertiesQueue() })
      mockAuthed(supabase)

      await expect(saveDetails('prop_1', null, fd({ door_code_unchanged: '1' })))
        .rejects.toThrow('REDIRECT:')

      expect(supabase.rpc).not.toHaveBeenCalledWith('store_property_door_code', expect.anything())
    })

    it('still writes the door code on a normal render (guard is not always-on)', async () => {
      const supabase = makeSupabase({ properties: happyPropertiesQueue() })
      mockAuthed(supabase)

      await expect(saveDetails('prop_1', null, fd({ door_code: '4821' })))
        .rejects.toThrow('REDIRECT:')

      expect(supabase.rpc).toHaveBeenCalledWith(
        'store_property_door_code',
        expect.objectContaining({ p_door_code: '4821' }),
      )
    })

    it('clears the code when the field is genuinely submitted empty', async () => {
      const supabase = makeSupabase({
        properties: [
          { data: { ...pristineExisting(), door_code_secret_id: 'sec_1' } },
          { data: { id: 'prop_1' }, error: null },
          { data: { setup_steps_completed: {} } },
          { data: { id: 'prop_1' }, error: null },
        ],
      })
      mockAuthed(supabase)

      await expect(saveDetails('prop_1', null, fd({ door_code: '' })))
        .rejects.toThrow('REDIRECT:')

      expect(supabase.rpc).toHaveBeenCalledWith(
        'store_property_door_code',
        expect.objectContaining({ p_door_code: null }),
      )
    })

    it('does not audit-log a door-code change that never happened', async () => {
      const supabase = makeSupabase({
        properties: [
          // An existing code IS set — the old guestAccessChanged clause read
          // the skipped render's empty submission as "cleared" and logged it.
          { data: { ...pristineExisting(), door_code_secret_id: 'sec_1' } },
          { data: { id: 'prop_1' }, error: null },
          { data: { setup_steps_completed: {} } },
          { data: { id: 'prop_1' }, error: null },
        ],
      })
      mockAuthed(supabase)

      await expect(saveDetails('prop_1', null, fd({ door_code_unchanged: '1' })))
        .rejects.toThrow('REDIRECT:')

      expect(logAuditEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'property.updated' }),
      )
    })
  })

  it('rejects and never touches the DB when the caller is unauthenticated', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))
    vi.mocked(requireOrgRole).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(saveDetails('prop_1', null, fd())).rejects.toThrow('REDIRECT:/login')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
