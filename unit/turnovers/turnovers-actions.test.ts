import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// triggerManualSync now consults a limiter; without this the test waits on a
// real Redis round trip that never resolves in CI.
vi.mock('@/lib/rate-limit', () => ({
  integrationResyncLimiter: { limit: vi.fn() },
  checkLimit: vi.fn(async () => ({ allowed: true, skipped: false, errored: false })),
}))
vi.mock('@/lib/inngest/client', () => {
  const send = vi.fn()
  return {
    inngest: { send },
    sendEventAsync: (...args: unknown[]) => { void Promise.resolve(send(...args)).catch(() => undefined) },
  }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/push/client', () => ({ sendPushToCrewMember: vi.fn() }))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { checkLimit } from '@/lib/rate-limit'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import {
  assignCrew,
  assignCrewIndividually,
  updateTurnoverStatus,
  createManualTurnover,
  addCrewToTurnover,
  removeCrewFromTurnover,
  bulkUpdateTurnoverStatus,
  archiveTurnover,
  unarchiveTurnover,
  triggerManualSync,
  acceptSuggestion,
  dismissSuggestion,
  rateTurnoverCompletion,
} from '@/app/(dashboard)/turnovers/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>, rpcs: Record<string, Resp> = {}) {
  // Every chained call is recorded so tests can assert on filters — notably
  // the .neq('status', 'completed') guard that makes turnover completion
  // race-safe (the WHERE clause, not an earlier read, is the guard).
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'not', 'is', 'limit', 'order', 'range']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  // `.rpc()` calls are recorded into the SAME `calls` array as `.from()` chains
  // so a test can assert on ordering — e.g. that no inventory/turnover write
  // happened outside the transactional RPC.
  const rpc = vi.fn((name: string, args: unknown) => {
    calls.push({ table: `rpc:${name}`, method: 'rpc', args: [args] })
    return Promise.resolve(rpcs[name] ?? { data: null, error: null })
  })
  return { from, rpc, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

// Every test that reaches the push-notification / service-client branch of
// assignCrew/addCrewToTurnover needs a service client stubbed, since that
// branch is wrapped in its own try/catch and must not fail the assertion.
function stubServiceClient() {
  vi.mocked(createServiceClient).mockReturnValue(makeSupabase({}) as never)
}

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

// Every action here is a PM board action and now gates on
// requireOrgRole(['admin','manager']) — matching the turnovers RLS policy,
// which a bare requireOrgMember() did not. Both are stubbed so a test never
// silently exercises the wrong gate.
function mockAuthed(ctx: unknown) {
  vi.mocked(requireOrgMember).mockResolvedValue(ctx as never)
  vi.mocked(requireOrgRole).mockResolvedValue(ctx as never)
}

function mockAuthFailure(err: unknown) {
  vi.mocked(requireOrgMember).mockRejectedValue(err)
  vi.mocked(requireOrgRole).mockRejectedValue(err)
}

describe('turnovers/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubServiceClient()
  })

  describe('assignCrew', () => {
    it('assigns crew to every turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'turnover/crew-assigned',
        data: { crew_member_id: 'crew_1', turnover_ids: ['t_1'], org_id: 'org_1' },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'turnover.crew.assigned',
      }))
    })

    it('rejects turnover ids that do not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['other-orgs-turnover'], 'crew_1')

      expect(result).toEqual({ error: 'Turnovers not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('crew_members')
    })

    it('rejects a crew member id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z' }] }],
        crew_members: [{ data: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'other-orgs-crew')

      expect(result).toEqual({ error: 'Crew member not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('warns, but still succeeds, when the crew member has marked time off on an assigned date', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [{ available_date: '2026-07-22' }] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result.success).toBe(true)
      expect(result.warning).toMatch(/marked time off/)
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure(new Error('REDIRECT:/login'))

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result).toEqual({ error: 'Failed to assign crew. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('assignCrewIndividually', () => {
    it('requires at least one assignment', async () => {
      const result = await assignCrewIndividually([])
      expect(result).toEqual({ error: 'No assignments to apply' })
    })

    it('groups assignments by crew member and applies them via assignCrew', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }] },
        ],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrewIndividually([{ turnoverId: 't_1', crewMemberId: 'crew_1' }])

      expect(result).toEqual({ success: true })
    })

    // assignCrew is a REPLACE — it deletes every OTHER crew member's
    // assignment for the turnovers it is given. The same turnover under two
    // crew members made the two grouped calls delete each other's row,
    // concurrently via Promise.all, and whichever landed last won. Both were
    // reported as applied.
    it('refuses the same turnover assigned to two crew members in one submit', async () => {
      const supabase = makeSupabase({})
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await assignCrewIndividually([
        { turnoverId: 't_1', crewMemberId: 'crew_a' },
        { turnoverId: 't_1', crewMemberId: 'crew_b' },
      ])

      expect(result.error).toMatch(/only be assigned to one crew member/)
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateTurnoverStatus', () => {
    // ── A cancelled turnover must not be completable ────────────────────────
    //
    // Completing one fires turnover/completed, which posts a cleaning_fee to
    // the owner's ledger — a real charge for work that was called off. The
    // guard was .neq('status','completed') alone, which a cancelled row passes.
    // Production holds 6 cancelled turnovers, so the state is reachable.
    it('refuses to complete a cancelled turnover and says so, rather than reporting success', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: null, error: null },                 // the guarded UPDATE matched nothing
          { data: { status: 'cancelled' }, error: null }, // ...because it is cancelled
        ],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await updateTurnoverStatus('t_1', 'completed')

      expect(result.error).toMatch(/cancelled/i)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    // The same 0-row outcome means something entirely different when a
    // concurrent request won the completion claim — that IS a success, and
    // re-firing the event would double-count the metric and overwrite
    // completed_at. Distinguishing the two is the whole point of the re-read.
    it('still treats an already-completed turnover as success without re-firing', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: null, error: null },                 // lost the completion claim
          { data: { status: 'completed' }, error: null },
        ],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await updateTurnoverStatus('t_1', 'completed')

      expect(result.error).toBeUndefined()
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('marks a turnover completed and fires the completion event', async () => {
      // The conditional UPDATE returns the row it actually matched.
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' }, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateTurnoverStatus('t_1', 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/completed' }))
    })

    // The race the crew route explicitly rejects: two concurrent completions
    // must not both fire turnover/completed (double-counted metrics) or both
    // stamp completed_at (corrupted durations). The .neq guard in the WHERE
    // clause is what makes exactly one UPDATE match a row.
    it('guards completion with .neq(status, completed) rather than an earlier read', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' }, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateTurnoverStatus('t_1', 'completed')

      expect(supabase.calls).toContainEqual(
        expect.objectContaining({ table: 'turnovers', method: 'neq', args: ['status', 'completed'] })
      )
    })

    // The WHERE clause is the real guard; the re-read below it only explains
    // WHY zero rows matched. Asserting on the re-read alone would let someone
    // delete this filter — and actually complete a cancelled turnover, posting
    // the cleaning fee — with every test still green. That is not a
    // hypothetical: removing this .neq broke nothing until this test existed.
    it('guards completion against cancelled in the WHERE clause, not just in the message', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' }, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateTurnoverStatus('t_1', 'completed')

      expect(supabase.calls).toContainEqual(
        expect.objectContaining({ table: 'turnovers', method: 'neq', args: ['status', 'cancelled'] })
      )
    })

    it('does not apply the completion guard to non-completion status changes', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' }, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateTurnoverStatus('t_1', 'in_progress')

      expect(supabase.calls).not.toContainEqual(
        expect.objectContaining({ method: 'neq', args: ['status', 'completed'] })
      )
    })

    it('does not re-fire the completion event when a concurrent request won the race', async () => {
      // No row matched: the turnover was already completed, so the request
      // that DID match it owns the downstream automations.
      const supabase = makeSupabase({
        turnovers: [{ data: null, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateTurnoverStatus('t_1', 'completed', 'redundant re-save')

      expect(result).toEqual({ success: true })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('scopes the status update to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', org_id: 'org_1' }, error: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateTurnoverStatus('t_1', 'in_progress')

      expect(supabase.from).toHaveBeenCalledWith('turnovers')
      expect(supabase.calls).toContainEqual(
        expect.objectContaining({ table: 'turnovers', method: 'eq', args: ['org_id', 'org_1'] })
      )
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure(new Error('REDIRECT:/login'))

      const result = await updateTurnoverStatus('t_1', 'in_progress')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('createManualTurnover', () => {
    function turnoverFd(overrides: Partial<Record<string, string>> = {}) {
      return fd({
        property_id:   'prop_1',
        checkout_date: '2026-07-22',
        checkin_date:  '2026-07-23',
        ...overrides,
      })
    }

    it('creates a turnover when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:          [{ data: { id: 'prop_1', timezone: 'America/Chicago' } }],
        checklist_templates: [{ data: { id: 'tmpl_1' } }],
        turnovers:           [{ data: { id: 't_1' } }],
      })
      mockAuthed({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd())

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/created' }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      mockAuthed({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({ property_id: 'other-orgs-property' }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('turnovers')
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects when check-in is not after checkout', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1', timezone: 'America/Chicago' } }] })
      mockAuthed({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({
        checkout_date: '2026-07-23', checkin_date: '2026-07-22',
      }))

      expect(result).toEqual({ error: 'Check-in must be after checkout' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure(new Error('REDIRECT:/login'))

      const result = await createManualTurnover(null, turnoverFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    // THE regression guard, and the assertion whose absence let this ship: the
    // whole suite passed both before and after the fix, because nothing ever
    // looked at the timestamp that got stored.
    //
    // `new Date('2026-07-22T11:00:00')` has no offset, so ECMAScript parses it
    // as SERVER-local — UTC on Vercel — storing 11:00Z for an 11:00 Central
    // checkout, six hours early. The iCal path always converted through
    // propertyLocalToUtc, so the two creation paths disagreed by the offset on
    // the same board.
    it('stores checkout/checkin in the PROPERTY timezone, not the server timezone', async () => {
      const supabase = makeSupabase({
        properties:          [{ data: { id: 'prop_1', timezone: 'America/Chicago' } }],
        checklist_templates: [{ data: { id: 'tmpl_1' } }],
        turnovers:           [{ data: { id: 't_1' } }],
      })
      mockAuthed({ supabase, membership } as never)

      await createManualTurnover(null, turnoverFd({
        checkout_date: '2026-07-22', checkout_time: '11:00',
        checkin_date:  '2026-07-22', checkin_time:  '16:00',
      }))

      const insert = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'insert')
      const row    = insert!.args[0] as { checkout_datetime: string; checkin_datetime: string; window_minutes: number }

      // July → CDT (UTC-5). 11:00 local is 16:00Z, NOT 11:00Z.
      expect(row.checkout_datetime).toBe('2026-07-22T16:00:00.000Z')
      expect(row.checkin_datetime).toBe('2026-07-22T21:00:00.000Z')
      // Unaffected by the bug either way — both ends shifted equally, which is
      // why priority never looked wrong and the skew stayed invisible.
      expect(row.window_minutes).toBe(300)
    })

    it('falls back to America/New_York when the property has no timezone', async () => {
      const supabase = makeSupabase({
        properties:          [{ data: { id: 'prop_1', timezone: null } }],
        checklist_templates: [{ data: { id: 'tmpl_1' } }],
        turnovers:           [{ data: { id: 't_1' } }],
      })
      mockAuthed({ supabase, membership } as never)

      await createManualTurnover(null, turnoverFd({
        checkout_date: '2026-07-22', checkout_time: '11:00',
      }))

      const insert = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'insert')
      const row    = insert!.args[0] as { checkout_datetime: string }
      // July → EDT (UTC-4).
      expect(row.checkout_datetime).toBe('2026-07-22T15:00:00.000Z')
    })

    // An Invalid Date's getTime() is NaN, and every comparison against NaN is
    // false — so `checkinDT <= checkoutDT` PASSED, window_minutes became NaN,
    // priority silently fell to 'medium', and the only symptom was a
    // RangeError from toISOString() reported as "Operation failed".
    it('rejects an unparseable date instead of failing later on toISOString', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1', timezone: 'America/Chicago' } }] })
      mockAuthed({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({ checkout_date: 'not-a-date' }))

      expect(result).toEqual({ error: 'Enter a valid checkout and check-in date and time.' })
      expect(supabase.calls.some((c) => c.table === 'turnovers')).toBe(false)
    })

    it('rejects a window longer than 30 days', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1', timezone: 'America/Chicago' } }] })
      mockAuthed({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({
        checkout_date: '2026-07-22', checkin_date: '2026-09-30',
      }))

      expect(result.error).toMatch(/longer than 30 days/)
      expect(supabase.calls.some((c) => c.table === 'turnovers')).toBe(false)
    })
  })

  describe('addCrewToTurnover', () => {
    it('adds crew to verified turnovers additively', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', status: 'pending_assignment', checkout_datetime: '2026-07-22T11:00:00.000Z', checkin_datetime: '2026-07-22T15:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        turnover_assignments: [{ data: [] }, { error: null }, { data: [] }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
        crew_availability: [{ data: [] }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['t_1'], 'crew_1')

      expect(result).toEqual({ success: true })
    })

    it('rejects turnover ids that do not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['other-orgs-turnover'], 'crew_1')

      expect(result).toEqual({ error: 'Turnovers not found' })
    })

    it('rejects a crew member id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', status: 'assigned', checkout_datetime: '2026-07-22T11:00:00.000Z', checkin_datetime: '2026-07-22T15:00:00.000Z' }] }],
        crew_members: [{ data: null }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['t_1'], 'other-orgs-crew')

      expect(result).toEqual({ error: 'Crew member not found' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      mockAuthFailure(new Error('REDIRECT:/login'))

      const result = await addCrewToTurnover(['t_1'], 'crew_1')

      expect(result).toEqual({ error: 'Failed to assign crew. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('removeCrewFromTurnover', () => {
    it('removes crew through the transactional RPC, scoped to the caller org', async () => {
      const supabase = makeSupabase({}, {
        remove_crew_from_turnover: { data: { ok: true, remaining: 0, reverted: true } },
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('t_1', 'crew_1')

      expect(result).toEqual({ success: true })
      expect(supabase.rpc).toHaveBeenCalledWith('remove_crew_from_turnover', {
        p_turnover_id:    't_1',
        p_crew_member_id: 'crew_1',
        // The org scope is what makes SECURITY DEFINER safe — it must come
        // from the membership, never from the caller's arguments.
        p_org_id:         'org_1',
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'turnover.crew.removed',
      }))
    })

    it('does the delete, the count and the status revert in ONE statement, never as separate writes', async () => {
      // The regression this encodes: as separate reads and writes, two
      // concurrent removals could each COUNT before the other's DELETE
      // committed, both skip the revert, and strand the turnover `assigned`
      // with zero crew — invisible on the needs-assignment board.
      const supabase = makeSupabase({}, {
        remove_crew_from_turnover: { data: { ok: true, remaining: 0, reverted: true } },
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await removeCrewFromTurnover('t_1', 'crew_1')

      expect(supabase.from).not.toHaveBeenCalledWith('turnover_assignments')
      expect(supabase.from).not.toHaveBeenCalledWith('turnovers')
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({}, {
        remove_crew_from_turnover: { data: { ok: false, reason: 'turnover_not_found' } },
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('other-orgs-turnover', 'crew_1')

      expect(result).toEqual({ error: 'Turnover not found' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('reports a crew member who was not assigned, instead of claiming success', async () => {
      // Previously the DELETE's result was discarded, so "nothing was
      // assigned" and "the delete failed" both fell through to a success the
      // PM had no reason to doubt.
      const supabase = makeSupabase({}, {
        remove_crew_from_turnover: { data: { ok: false, reason: 'assignment_not_found' } },
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('t_1', 'crew_1')

      expect(result).toEqual({ error: 'That crew member is not assigned to this turnover.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('surfaces an RPC error rather than reporting the removal as done', async () => {
      const supabase = makeSupabase({}, {
        remove_crew_from_turnover: { data: null, error: { message: 'deadlock detected' } },
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('t_1', 'crew_1')

      expect(result).toEqual({ error: 'Failed to remove crew member. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(logAuditEvent).not.toHaveBeenCalled()
    })
  })

  describe('bulkUpdateTurnoverStatus', () => {
    it('completes only turnovers verified to belong to the caller org and not already terminal', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', org_id: 'org_1' }] }, { error: null }],
      })
      mockAuthed({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['t_1'], 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/completed' }))
    })

    // ── Regression: the race updateTurnoverStatus already fixed ──────────
    // This read `eligible`, then updated unconditionally with a fresh
    // completed_at, then fanned out per row. Two concurrent bulk completions
    // both matched, both re-stamped completed_at and both fired
    // turnover/completed — emit-completion-metric double-counted and the
    // durations assignment_outcomes/crew scoring derive were corrupted.
    // Pre-fix there are TWO from('turnovers') calls (a pre-read plus an
    // unguarded update) and the status filter sits on the read, so both
    // assertions below fail.
    it('guards eligibility in the UPDATE WHERE clause, not in an earlier read', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', org_id: 'org_1' }] }],
      })
      mockAuthed({ supabase, membership } as never)

      await bulkUpdateTurnoverStatus(['t_1'], 'completed')

      // One statement: UPDATE ... WHERE org/status ... RETURNING. No pre-read.
      expect(supabase.from.mock.calls.filter(([t]: [string]) => t === 'turnovers')).toHaveLength(1)
      expect(supabase.calls).toContainEqual(
        expect.objectContaining({ table: 'turnovers', method: 'update' })
      )
      expect(supabase.calls).toContainEqual(
        expect.objectContaining({
          table: 'turnovers', method: 'in',
          args: ['status', ['pending_assignment', 'assigned', 'in_progress', 'flagged']],
        })
      )
    })

    // Only rows the UPDATE actually claimed emit — the loser of a race gets
    // an empty RETURNING set and fires nothing.
    // 0 rows used to return { success: true }, collapsing three outcomes:
    // nothing eligible, RLS refused the write, and ids from another org. The
    // PM clicked complete on a selection and none of it took.
    it('reports failure — not success — when the guarded UPDATE claims no rows', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      mockAuthed({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['t_1'], 'completed')

      expect(result.success).toBeUndefined()
      expect(result.error).toMatch(/None of those turnovers/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('reports failure when none of the ids are eligible (e.g. belong to another org)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      mockAuthed({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['other-orgs-turnover'], 'completed')

      expect(result.error).toMatch(/None of those turnovers/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('warns when only some of the selection completed', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', org_id: 'org_1' }] }],
      })
      mockAuthed({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['t_1', 't_2', 't_3'], 'completed')

      expect(result.success).toBe(true)
      expect(result.warning).toMatch(/2 of 3/)
    })
  })

  describe('archiveTurnover / unarchiveTurnover', () => {
    it('archives only completed turnovers scoped to the caller org', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [{ id: 't_1' }] }] })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await archiveTurnover(['t_1'])

      expect(result).toEqual({ success: true })
      expect(supabase.from).toHaveBeenCalledWith('turnovers')
    })

    it('requires at least one turnover id', async () => {
      const result = await archiveTurnover([])
      expect(result).toEqual({ error: 'No turnovers selected' })
    })

    it('unarchives turnovers scoped to the caller org', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [{ id: 't_1' }] }] })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await unarchiveTurnover(['t_1'])

      expect(result).toEqual({ success: true })
    })
  })

  describe('triggerManualSync', () => {
    it('sends the sync-all event for the caller org', async () => {
      mockAuthed({ membership, user: { id: 'user_1' } } as never)

      const result = await triggerManualSync()

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({ name: 'ical/sync.all.requested', data: { org_id: 'org_1' } })
    })

    // Each call fans out to every iCal feed in the org — outbound HTTP to
    // third-party calendar hosts — and nothing stopped a PM holding the button
    // down.
    it('refuses a second sync inside the throttle window, without firing the event', async () => {
      mockAuthed({ membership, user: { id: 'user_1' } } as never)
      vi.mocked(checkLimit).mockResolvedValueOnce({ allowed: false, skipped: false, errored: false } as never)

      const result = await triggerManualSync()

      expect(result.error).toMatch(/just started/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error when the caller is unauthenticated', async () => {
      mockAuthFailure(new Error('REDIRECT:/login'))

      const result = await triggerManualSync()

      expect(result).toEqual({ error: 'Could not start the calendar sync. Try again in a moment.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('acceptSuggestion / dismissSuggestion', () => {
    it('accepts a pending suggestion for a turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers:             [
          { data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: ['crew_1'] } },
          { data: { id: 't_1' }, error: null },  // the suggestion_status write, read back
          { error: null },                       // advancePendingToAssigned
        ],
        crew_members:          [{ data: [{ id: 'crew_1' }] }],
        turnover_assignments:  [{ error: null }],
        properties:            [{ data: { bedrooms: 3 } }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('t_1')

      expect(result).toEqual({ success: true })

      // The status advance is the SIBLING helper's filtered statement, not a
      // column folded into the suggestion write — that is what stops it walking
      // an in_progress turnover backwards.
      const advance = supabase.calls.find(
        c => c.table === 'turnovers' && c.method === 'update' &&
             (c.args[0] as { status?: string })?.status === 'assigned',
      )
      expect(advance).toBeTruthy()
      expect(
        supabase.calls.some(c => c.table === 'turnovers' && c.method === 'eq' &&
          c.args[0] === 'status' && c.args[1] === 'pending_assignment'),
      ).toBe(true)
    })

    // The board hides `cancelled` but NOT `completed`, so a turnover the PM
    // marked done themselves keeps rendering its suggestion banner with a live
    // Accept button. That wrote `status: 'assigned'` with no precondition: the
    // finished turnover left the Completed column, kept its now-meaningless
    // completed_at, and could be completed a second time.
    it.each([
      ['completed', /already complete/],
      ['cancelled', /was cancelled/],
    ])('refuses to reopen a %s turnover, writing nothing', async (status, message) => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', status, suggested_crew_ids: ['crew_1'] } }],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await acceptSuggestion('t_1')

      expect(result.error).toMatch(message)
      expect(supabase.calls.some(c => c.method === 'update' || c.method === 'upsert')).toBe(false)
    })

    // The read above produces the message; the WHERE clause is what makes it
    // race-safe. A completion landing between the two must not be overwritten.
    it('gates the suggestion write on the status allowlist, not just the earlier read', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: ['crew_1'] } },
          { data: null, error: null },   // completed in the gap — 0 rows, no error
        ],
        crew_members:         [{ data: [{ id: 'crew_1' }] }],
        turnover_assignments: [{ error: null }],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await acceptSuggestion('t_1')

      expect(result.error).toMatch(/permission|no longer exists/)
      const statusFilter = supabase.calls.find(
        c => c.table === 'turnovers' && c.method === 'in' && c.args[0] === 'status',
      )
      expect(statusFilter?.args[1]).toEqual(
        expect.arrayContaining(['pending_assignment', 'assigned', 'in_progress', 'flagged']),
      )
      expect(statusFilter?.args[1]).not.toContain('completed')
      expect(statusFilter?.args[1]).not.toContain('cancelled')
    })

    // Every other assignment path proves its crew ids belong to the org before
    // writing turnover_assignments. This one trusted suggested_crew_ids
    // wholesale, and that table's INSERT policy checks org_id ALONE — so a row
    // pairing the caller's org_id with a foreign crew_member_id passes RLS.
    it('refuses to assign a suggested crew id that is not in the caller org', async () => {
      const supabase = makeSupabase({
        turnovers:    [{ data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: ['crew_from_another_org'] } }],
        crew_members: [{ data: [] }],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await acceptSuggestion('t_1')

      expect(result.error).toMatch(/no longer available/)
      expect(supabase.calls.some(c => c.table === 'turnover_assignments')).toBe(false)
    })

    // A failed crew read must not read as "zero matching crew" and it must not
    // read as "all fine" either — it fails closed with its own message.
    it('fails closed when the crew verification read itself errors', async () => {
      const supabase = makeSupabase({
        turnovers:    [{ data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: ['crew_1'] } }],
        crew_members: [{ data: null, error: { message: 'permission denied', code: '42501' } }],
      })
      mockAuthed({ supabase, membership, user: { id: 'user_1' } } as never)

      const result = await acceptSuggestion('t_1')

      expect(result.error).toMatch(/verify the suggested crew/)
      expect(supabase.calls.some(c => c.table === 'turnover_assignments')).toBe(false)
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: null }] })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('other-orgs-turnover')

      expect(result).toEqual({ error: 'Turnover not found' })
    })

    it('returns an error when there is no suggestion to accept', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: [] } }],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('t_1')

      expect(result).toEqual({ error: 'No suggestion to accept' })
    })

    it('dismisses a suggestion scoped to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: { property_id: 'prop_1', suggested_crew_ids: [] } },
          { data: { id: 't_1' }, error: null },  // the dismissal write, read back
        ],
      })
      mockAuthed({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dismissSuggestion('t_1')

      expect(result).toEqual({ success: true })
    })
  })

  // Every action here is a PM BOARD action, but they all ran on bare
  // requireOrgMember(), leaving RLS as the only real gate — and a refused
  // UPDATE returns 0 rows with NO error, so the refusal was invisible. The
  // turnovers_update policy also admits CREW for turnovers assigned to them
  // (so the crew PWA can start/complete work), which meant a crew member
  // satisfied it for archive, bulk-complete and dismiss too.
  describe('role gating', () => {
    it.each([
      ['archiveTurnover',          () => archiveTurnover(['t_1'])],
      ['unarchiveTurnover',        () => unarchiveTurnover(['t_1'])],
      ['bulkUpdateTurnoverStatus', () => bulkUpdateTurnoverStatus(['t_1'], 'completed' as const)],
      ['acceptSuggestion',         () => acceptSuggestion('t_1')],
      ['dismissSuggestion',        () => dismissSuggestion('t_1')],
      ['triggerManualSync',        () => triggerManualSync()],
    ])('%s gates on admin|manager, not bare membership', async (_name, run) => {
      const supabase = makeSupabase({})
      // The role gate rejects; requireOrgMember would have let this through.
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership, user: { id: 'u' } } as never)
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('You do not have permission to perform this action.'))

      const result = await run()

      expect(result.success).toBeUndefined()
      expect(result.error).toBeTruthy()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('rateTurnoverCompletion', () => {
    it('rates a completed turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: { id: 't_1', status: 'completed', turnover_assignments: [{ crew_member_id: 'crew_1' }] },
        }],
      })
      const service = makeSupabase({ assignment_outcomes: [{ error: null }] })
      vi.mocked(createServiceClient).mockReturnValue(service as never)
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'turnover.pm_rating.submitted',
        metadata: { rating: 5 },
      }))
    })

    it('rejects an out-of-range rating before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 6)

      expect(result).toEqual({ error: 'Rating must be between 1 and 5' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('other-orgs-turnover', 5)

      expect(result).toEqual({ error: 'Turnover not found' })
    })

    it('refuses to rate a turnover that is not completed', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', status: 'in_progress', turnover_assignments: [] } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ error: 'Only completed turnovers can be rated' })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ error: 'Failed to save rating. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
