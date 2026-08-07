import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('@/lib/crew-auth', () => ({
  requireCrewMember: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/crew/turnovers/[id]/complete/route'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'neq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function request() {
  return new NextRequest('http://localhost/api/crew/turnovers/turnover_1/complete', { method: 'POST' })
}

function call(turnoverId: string) {
  return POST(request(), { params: Promise.resolve({ id: turnoverId }) })
}

function authOk(supabase: unknown, crewOrgId = 'org_1') {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok: true,
    user: { id: 'user_1' },
    supabase,
    crew: { id: 'crew_1', org_id: crewOrgId },
  } as never)
}

describe('POST /api/crew/turnovers/[id]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the crew-auth failure response unchanged when not an active crew member', async () => {
    const unauthorized = NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    vi.mocked(requireCrewMember).mockResolvedValue({ ok: false, response: unauthorized } as never)

    const res = await call('turnover_1')

    expect(res.status).toBe(401)
  })

  it('IDOR: returns 404 for a turnover that exists but belongs to a different org than the crew member', async () => {
    // The scoped .eq('org_id', crew.org_id) lookup returns nothing for a
    // cross-org turnover id — this is the guard under test.
    const supabase = makeSupabase({ turnovers: [{ data: null, error: null }] })
    authOk(supabase, 'org_1')

    const res = await call('other-orgs-turnover')

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('H-7: returns 404 when the crew member has no turnover_assignments row for this turnover', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress', inventory_confirmed_complete_at: null }, error: null }],
      turnover_assignments: [{ data: null, error: null }], // not assigned
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json).toEqual({ error: 'Turnover not found' })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('no-ops without re-firing the event when the turnover is already completed', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'completed', inventory_confirmed_complete_at: null }, error: null }],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('no-ops without re-firing the event when a concurrent request already won the completion claim', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress', inventory_confirmed_complete_at: null }, error: null },
        { data: null, error: null }, // claim update — lost the race
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
      checklist_instances:  [{ data: null, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns 500 on a DB error during the completion claim', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress', inventory_confirmed_complete_at: null }, error: null },
        { data: null, error: { message: 'db down' } },
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
      checklist_instances:  [{ data: null, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(500)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('completes the turnover scoped to the crew member\'s own org, fires turnover/completed, and logs an audit event', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress', inventory_confirmed_complete_at: null }, error: null },
        { data: { id: 'turnover_1' }, error: null }, // claim update succeeds
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
      checklist_instances:  [{ data: null, error: null }],
    })
    authOk(supabase, 'org_1')

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'turnover/completed',
      data: expect.objectContaining({
        turnover_id:          'turnover_1',
        org_id:               'org_1',
        completed_by_crew_id: 'crew_1',
      }),
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', actorId: 'user_1', action: 'turnover.completed', targetId: 'turnover_1',
    }))

    // The turnover lookup and the completion claim both explicitly scope to
    // the crew member's own org — not just the turnover id in the URL.
    const turnoverCalls = supabase.calls.filter((c) => c.table === 'turnovers')
    const orgScoped = turnoverCalls.some((c) => c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === 'org_1')
    expect(orgScoped).toBe(true)
  })

  // ── A cancelled turnover must not be completable ───────────────────────────
  //
  // Nothing removes a cancelled turnover from the crew's Dexie cache and no
  // crew screen checks the status, so a PM cancelling a job the crew already
  // holds offline left it looking perfectly normal and tappable. Completing it
  // fires turnover/completed, which posts a cleaning_fee to the owner's ledger
  // — a real charge for work that was called off. Production holds 6 cancelled
  // turnovers, so this is a reachable state.
  it('refuses to complete a cancelled turnover, and posts no fee', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'cancelled', inventory_confirmed_complete_at: null } }],
      turnover_assignments: [{ data: { id: 'ta_1' } }],
    })
    authOk(supabase)

    const res  = await call('turnover_1')
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/cancelled/i)
    expect(inngest.send).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // 4xx is TERMINAL in lib/dexie/net.ts, which is the right classification
  // here: replaying this can never succeed. It dead-letters into the
  // failed-sync banner where the crew member can read why.
  it('answers the cancelled case with a terminal status, not a retryable one', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'cancelled', inventory_confirmed_complete_at: null } }],
      turnover_assignments: [{ data: { id: 'ta_1' } }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  // ── A failed READ must not dead-letter the crew member's work ─────────────
  //
  // lib/dexie/net.ts classifies 4xx as TERMINAL and >=500 as transient. This
  // route answered a transient DB error with 404, which discarded the queued
  // completion permanently — the job was done, the PM never saw it finish, and
  // the cleaning fee never posted. The sibling start route was fixed for
  // exactly this; this one was not.
  it('returns 503, not 404, when the turnover read itself fails', async () => {
    const supabase = makeSupabase({
      turnovers: [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(503)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('still returns 404 when the turnover genuinely does not exist', async () => {
    const supabase = makeSupabase({ turnovers: [{ data: null, error: null }] })
    authOk(supabase)

    expect((await call('turnover_1')).status).toBe(404)
  })

  // A failed checklist read silently changed the RECORDED COMPLETION TIME:
  // resolveTurnoverCompletedAt falls back to wall-clock when a confirmation
  // timestamp is missing, and that timestamp feeds crew duration,
  // assignment_outcomes and crew scoring.
  it('returns 503 rather than stamping a wall-clock time when the checklist read fails', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', property_id: 'prop_1', org_id: 'org_1', status: 'in_progress', inventory_confirmed_complete_at: '2026-08-07T10:00:00.000Z' } }],
      turnover_assignments: [{ data: { id: 'ta_1' } }],
      checklist_instances:  [{ data: null, error: { code: '57014', message: 'timeout' } }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(503)
    expect(inngest.send).not.toHaveBeenCalled()
  })
})
