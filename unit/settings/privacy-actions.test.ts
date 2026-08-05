import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgRole: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { anonymizeGuestData } from '@/app/(dashboard)/settings/privacy/actions'
import { requireOrgRole } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

interface QueuedByTable {
  [table: string]: unknown[]
}

/**
 * Queued results are consumed per table, in call order. The action makes more
 * than one round-trip per table now (bookings: select → update, per batch;
 * optins: count → delete), so the queues are read positionally — an entry that
 * runs out falls back to `{ data: null, error: null }`.
 *
 * See unit/settings/settings-actions.test.ts for the pattern this mirrors.
 */
function makeSupabase(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []
  // RPCs land in the SAME log as table calls so ordering between them is
  // assertable — the Vault delete must precede the UPDATE that nulls the only
  // pointer to the secret, and a separate log cannot express that.
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    calls.push({ table: '__rpc__', method: fn, args: [args] })
    return { data: null, error: null }
  })

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'update', 'delete', 'eq', 'in', 'is', 'not', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }

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

  return { from, rpc, calls }
}

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function mockAuthed(supabaseForServiceClient: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireOrgRole).mockResolvedValue({
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

/** One booking batch that anonymizes cleanly, with no opt-in rows. */
function oneBatch(bookings: Array<{ id: string; door_code_secret_id: string | null }>) {
  return {
    bookings: [
      { data: bookings, error: null },   // select batch 0
      { data: null, error: null },       // update batch 0
      { data: [], error: null },         // select batch 1 — drains the loop
    ],
    guidebook_guest_sms_optins: [
      { data: null, error: null, count: 0 },  // retained count
      { data: [], error: null },              // deleted rows
    ],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auditMetadata = () => (logAuditEvent as any).mock.calls[0][0].metadata

describe('settings/privacy/actions — anonymizeGuestData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when the auth gate rejects, without touching the DB', async () => {
    vi.mocked(requireOrgRole).mockRejectedValue(new Error('REDIRECT:/login'))

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toEqual({
      success: false,
      bookingsAnonymized: 0,
      error: 'Operation failed. Please try again.',
    })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  // The action runs with the SERVICE ROLE, so RLS is not a backstop: the auth
  // gate is the only thing standing between a caller and an irreversible,
  // org-wide scrub of guest PII. It shipped as requireOrgMember(), which let a
  // `viewer` or `crew` member destroy booking data they cannot even read.
  it('is gated on requireOrgRole([admin]) — not bare org membership', async () => {
    const supabase = makeSupabase(oneBatch([{ id: 'bk_1', door_code_secret_id: null }]))
    mockAuthed(supabase)

    await anonymizeGuestData('guest@example.com')

    expect(requireOrgRole).toHaveBeenCalledWith(['admin'])
  })

  it('rejects a malformed email before touching the DB', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const result = await anonymizeGuestData('not-an-email')

    expect(result).toEqual({ success: false, bookingsAnonymized: 0, error: 'Invalid email address' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('scopes both the lookup and the update to the caller org_id — never anonymizes another org’s guest', async () => {
    const supabase = makeSupabase(oneBatch([
      { id: 'bk_1', door_code_secret_id: null },
      { id: 'bk_2', door_code_secret_id: null },
    ]))
    mockAuthed(supabase)

    const result = await anonymizeGuestData('Guest@Example.com')

    expect(result).toMatchObject({ success: true, bookingsAnonymized: 2 })

    const selectEq = supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'eq')
    expect(selectEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    // Email is normalized to lowercase/trimmed before the query
    expect(selectEq.some((c) => c.args[0] === 'guest_email' && c.args[1] === 'guest@example.com')).toBe(true)

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(updateCall).toBeDefined()
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
    expect(auditMetadata().email_hash).not.toContain('@')
    expect(JSON.stringify(auditMetadata())).not.toContain('guest@example.com')
  })

  // ==========================================================================
  // The erasure surface. lib/inngest/functions/cron/guest-pii-retention.ts
  // clears five things per booking; this action shipped clearing two, while
  // audit-logging request_type: 'erasure_article_17'. A compliance record
  // asserting an erasure that did not happen is worse than no button at all.
  // ==========================================================================
  it('clears the FULL guest PII surface, not just name and email', async () => {
    const supabase = makeSupabase(oneBatch([{ id: 'bk_1', door_code_secret_id: null }]))
    mockAuthed(supabase)

    await anonymizeGuestData('guest@example.com')

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch = updateCall!.args[0] as any

    expect(patch.guest_email).toBeNull()
    expect(patch.guest_name).toBe('[Deleted]')
    // raw_ical_data is the OTA feed payload — it carries the guest's name and
    // usually their email verbatim in jsonb. Leaving it is not an erasure.
    expect(patch.raw_ical_data).toBeNull()
    expect(patch.door_code_secret_id).toBeNull()
    expect(patch.guest_pii_anonymized_at).toEqual(expect.any(String))
  })

  it('deletes the Vault door-code secret BEFORE nulling the pointer to it', async () => {
    const supabase = makeSupabase(oneBatch([
      { id: 'bk_1', door_code_secret_id: 'sec_1' },
      { id: 'bk_2', door_code_secret_id: null },
      { id: 'bk_3', door_code_secret_id: 'sec_3' },
    ]))
    mockAuthed(supabase)

    await anonymizeGuestData('guest@example.com')

    expect(supabase.rpc).toHaveBeenCalledTimes(2)
    expect(supabase.rpc).toHaveBeenCalledWith('delete_vault_secret', { p_secret_id: 'sec_1' })
    expect(supabase.rpc).toHaveBeenCalledWith('delete_vault_secret', { p_secret_id: 'sec_3' })
  })

  // door_code_secret_id is the ONLY pointer to the Vault secret. Nulling it
  // first orphans the secret with nothing left to find it by.
  it('does not null door_code_secret_id before the Vault delete has been attempted', async () => {
    const supabase = makeSupabase(oneBatch([{ id: 'bk_1', door_code_secret_id: 'sec_1' }]))
    mockAuthed(supabase)

    await anonymizeGuestData('guest@example.com')

    const vaultAt  = supabase.calls.findIndex((c) => c.method === 'delete_vault_secret')
    const updateAt = supabase.calls.findIndex((c) => c.table === 'bookings' && c.method === 'update')
    expect(vaultAt).toBeGreaterThanOrEqual(0)
    expect(updateAt).toBeGreaterThanOrEqual(0)
    expect(vaultAt).toBeLessThan(updateAt)
  })

  // A secret that is already gone must not block the anonymization of the row
  // referencing it.
  it('continues the scrub when a Vault delete fails', async () => {
    const supabase = makeSupabase(oneBatch([{ id: 'bk_1', door_code_secret_id: 'sec_1' }]))
    mockAuthed(supabase)
    supabase.rpc.mockResolvedValue({ data: null, error: { code: '42P01', message: 'gone' } } as never)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toMatchObject({ success: true, bookingsAnonymized: 1 })
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(true)
  })

  // GDPR Art. 17(3)(b): an opt-in row carrying a STOP is a TCPA suppression
  // record, retained under a legal obligation. Deleting it would let the
  // platform text a number that opted out.
  it('deletes never-opted-out SMS opt-ins and retains STOP records', async () => {
    const supabase = makeSupabase({
      ...oneBatch([{ id: 'bk_1', door_code_secret_id: null }]),
      guidebook_guest_sms_optins: [
        { data: null, error: null, count: 2 },              // retained (opted out)
        { data: [{ id: 'oi_1' }], error: null },            // deleted
      ],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toMatchObject({ optInsDeleted: 1, optInsRetained: 2 })

    const optCalls = supabase.calls.filter((c) => c.table === 'guidebook_guest_sms_optins')
    expect(optCalls.some((c) => c.method === 'delete')).toBe(true)
    // The delete is filtered to rows that never opted out …
    expect(optCalls.some((c) => c.method === 'is' && c.args[0] === 'opted_out_at' && c.args[1] === null)).toBe(true)
    // … and the count that does the opposite is the retained tally.
    expect(optCalls.some((c) => c.method === 'not' && c.args[0] === 'opted_out_at')).toBe(true)
    // Both halves are org-scoped.
    expect(optCalls.filter((c) => c.method === 'eq' && c.args[0] === 'org_id').length).toBe(2)

    expect(auditMetadata()).toMatchObject({ optins_deleted: 1, optins_retained: 2 })
  })

  // PostgREST truncates an unbounded .select() at max_rows = 1000 with a 200
  // and no truncation signal, so the original single-shot select reported a
  // partial scrub as a completed erasure. The loop is self-draining: the
  // UPDATE clears guest_email, which is the selection filter.
  it('drains more than one batch of bookings', async () => {
    const first  = Array.from({ length: 200 }, (_, i) => ({ id: `a_${i}`, door_code_secret_id: null }))
    const second = Array.from({ length: 3 },   (_, i) => ({ id: `b_${i}`, door_code_secret_id: null }))
    const supabase = makeSupabase({
      bookings: [
        { data: first,  error: null },
        { data: null,   error: null },
        { data: second, error: null },
        { data: null,   error: null },
      ],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toMatchObject({ success: true, bookingsAnonymized: 203 })
    expect(supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'update').length).toBe(2)
    // Every select is explicitly bounded — never an unbounded scan.
    expect(supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'limit').length).toBe(2)
  })

  // A batch that fails partway must report what it actually managed, not a
  // flat zero — the caller needs to know the erasure is incomplete AND that
  // some rows are already gone.
  it('reports the partial count when a later batch fails', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ({ id: `a_${i}`, door_code_secret_id: null }))
    const supabase = makeSupabase({
      bookings: [
        { data: first, error: null },
        { data: null,  error: null },
        { data: null,  error: { message: 'db down' } },
      ],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toEqual({ success: false, bookingsAnonymized: 200, error: 'db down' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('returns success with zero count when no bookings match, without calling update', async () => {
    const supabase = makeSupabase({
      bookings: [{ data: [], error: null }],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('nobody@example.com')

    expect(result).toEqual({ success: true, bookingsAnonymized: 0, optInsDeleted: 0, optInsRetained: 0 })
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

  it('surfaces an opt-in purge failure instead of scrubbing the bookings anyway', async () => {
    const supabase = makeSupabase({
      bookings: [
        { data: [{ id: 'bk_1', door_code_secret_id: null }], error: null },
      ],
      guidebook_guest_sms_optins: [
        { data: null, error: null, count: 0 },
        { data: null, error: { message: 'optins down' } },
      ],
    })
    mockAuthed(supabase)

    const result = await anonymizeGuestData('guest@example.com')

    expect(result).toEqual({ success: false, bookingsAnonymized: 0, error: 'optins down' })
    // The bookings must NOT be scrubbed — the guest's phone is still on file,
    // and the booking row is the only thing left that can find it again.
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
