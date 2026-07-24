import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { anonymizeGuestData } from '@/app/(dashboard)/settings/privacy/actions'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

interface QueuedByTable {
  [table: string]: unknown[]
}

// See unit/settings/settings-actions.test.ts for the pattern this mirrors.
function makeSupabase(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function mockAuthed(supabaseForServiceClient: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user: { id: USER_ID } as never,
    supabase: {} as never,
    membership: {
      org_id: ORG_ID,
      role:   'admin',
      org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
    } as never,
  })
  vi.mocked(createServiceClient).mockReturnValue(supabaseForServiceClient as never)
}

describe('settings/privacy/actions — anonymizeGuestData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when requireOrgMember rejects, without touching the DB', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toEqual({
      success: false,
      bookingsAnonymized: 0,
      error: 'Operation failed. Please try again.',
    })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a malformed email before touching the DB', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const result = await anonymizeGuestData('not-an-email')

    expect(result).toEqual({ success: false, bookingsAnonymized: 0, error: 'Invalid email address' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('scopes both the lookup and the update to the caller org_id — never anonymizes another org’s guest', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [{ id: 'bk_1' }, { id: 'bk_2' }], error: null }, // fetch affected
        { data: null, error: null },                             // update
      ],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('Guest@Example.com')

    expect(result).toEqual({ success: true, bookingsAnonymized: 2 })

    const selectEq = supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'eq')
    expect(selectEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    // Email is normalized to lowercase/trimmed before the query
    expect(selectEq.some((c) => c.args[0] === 'guest_email' && c.args[1] === 'guest@example.com')).toBe(true)

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(updateCall).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((updateCall!.args[0] as any).guest_email).toBeNull()
    const inCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'in')
    expect(inCall?.args).toEqual(['id', ['bk_1', 'bk_2']])

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      ORG_ID,
        actorId:    USER_ID,
        action:     'gdpr.data_erasure.completed',
        targetType: 'guest',
      })
    )
    // Never logs the raw email — only a SHA-256 hash
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = (logAuditEvent as any).mock.calls[0][0].metadata
    expect(metadata.email_hash).not.toContain('@')
    expect(JSON.stringify(metadata)).not.toContain('guest@example.com')
  })

  it('returns success with zero count when no bookings match, without calling update', async () => {
    const supabase = makeSupabase({
      bookings: [{ data: [], error: null }],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('nobody@example.com')

    expect(result).toEqual({ success: true, bookingsAnonymized: 0 })
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('surfaces a fetch error without calling update or the audit log', async () => {
    const supabase = makeSupabase({
      bookings: [{ data: null, error: { message: 'db down' } }],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toEqual({ success: false, bookingsAnonymized: 0, error: 'db down' })
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
