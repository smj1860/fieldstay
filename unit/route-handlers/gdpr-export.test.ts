import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async () => {
  // Routes under test now consult a limiter via checkLimit(). Mocked so the
  // suite never attempts a real Upstash round trip.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    dataExportLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:        checkLimitStub(),
    retryAfterSeconds: retryAfterSecondsStub,
  }
})
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { GET } from '@/app/api/gdpr/export/route'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'

const USER_ID = 'user_1'

type QueuedByTable = Record<string, Array<{ data?: unknown; error?: unknown }>>

function makeAdmin(queued: QueuedByTable = {}) {
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
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    // audit_events and turnover_assignments now PAGE to completeness with an
    // explicit ceiling instead of `.limit(500)`/`.limit(200)` — a `.limit()`
    // silently drops rows, which in an Article 15 right-of-access response is
    // a compliance defect rather than a tuning choice.
    chain.range  = (...a: unknown[]) => record('range', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeAuthClient(user: { id: string; email?: string; created_at?: string } | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user } })) } }
}

describe('GET /api/gdpr/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the route handler takes no request parameter — it structurally cannot read a client-supplied id/param', () => {
    // Regression guard: this route must always scope export data to the
    // authenticated session only. If a future change adds a `request`
    // parameter, that's a signal the export scope may have grown a
    // client-controllable id — worth a second look at that point.
    expect(GET.length).toBe(0)
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null) as never)

    const res = await GET()

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('exports only the authenticated caller\'s own data, scoping every query by their user id', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID, email: 'crew@example.com', created_at: '2026-01-01T00:00:00Z' }) as never,
    )
    const admin = makeAdmin({
      profiles: [{ data: { id: USER_ID, full_name: 'Jamie Crew', avatar_url: null, created_at: '2026-01-01T00:00:00Z' }, error: null }],
      organization_members: [{ data: [{ org_id: 'org_1', role: 'manager', invite_accepted_at: '2026-01-02T00:00:00Z' }], error: null }],
      crew_members: [{ data: null, error: null }],
      push_subscriptions: [{ data: [{ endpoint: 'https://push.example/e1', created_at: '2026-01-03T00:00:00Z' }], error: null }],
      audit_events: [{ data: [{ action: 'auth.account.created', target_type: 'user', target_id: USER_ID, created_at: '2026-01-01T00:00:00Z' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await GET()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Disposition')).toContain('fieldstay-data-export-')

    const payload = JSON.parse(await res.text())
    expect(payload.account.id).toBe(USER_ID)
    expect(payload.account.email).toBe('crew@example.com')
    expect(payload.organization_memberships).toEqual([
      { org_id: 'org_1', role: 'manager', invite_accepted_at: '2026-01-02T00:00:00Z' },
    ])
    expect(payload.crew_profile).toBeNull()
    expect(payload.crew_assignments).toEqual([])
    expect(payload.push_subscriptions).toEqual([{ endpoint: 'https://push.example/e1', created_at: '2026-01-03T00:00:00Z' }])

    // Every scoped lookup must key off the authenticated session's user id —
    // there is no request body/params on a GET here for an id to come from.
    const scopedTables = ['profiles', 'organization_members', 'crew_members', 'push_subscriptions']
    for (const table of scopedTables) {
      const eqCalls = admin.calls.filter((c) => c.table === table && c.method === 'eq')
      expect(
        eqCalls.some((c) => (c.args[0] === 'id' || c.args[0] === 'user_id') && c.args[1] === USER_ID),
      ).toBe(true)
    }
    const auditEq = admin.calls.filter((c) => c.table === 'audit_events' && c.method === 'eq')
    expect(auditEq.some((c) => c.args[0] === 'actor_id' && c.args[1] === USER_ID)).toBe(true)

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({ orgId: 'org_1', actorId: USER_ID, action: 'gdpr.data_export.requested', targetId: USER_ID }),
    ])
  })

  it('skips the turnover_assignments lookup entirely when the user has no crew_members row', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:          [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await GET()
    const payload = JSON.parse(await res.text())

    expect(payload.crew_assignments).toEqual([])
    expect(admin.calls.some((c) => c.table === 'turnover_assignments')).toBe(false)
  })

  it('includes crew turnover assignments, scoped to the caller\'s own crew_members id, when present', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:          [{ data: { id: 'crew_1', name: 'Jamie', role: 'cleaning', reliability_score: 90, capacity_score: 80, created_at: '2026-01-01T00:00:00Z' }, error: null }],
      turnover_assignments: [{ data: [{ turnover_id: 'turnover_1', assigned_at: '2026-01-05T00:00:00Z' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await GET()
    const payload = JSON.parse(await res.text())

    expect(payload.crew_assignments).toEqual([{ turnover_id: 'turnover_1', assigned_at: '2026-01-05T00:00:00Z' }])
    const eqCalls = admin.calls.filter((c) => c.table === 'turnover_assignments' && c.method === 'eq')
    expect(eqCalls.some((c) => c.args[0] === 'crew_member_id' && c.args[1] === 'crew_1')).toBe(true)
  })

  it('skips the audit-log-of-export step for a zero-org user instead of logging with an undefined org', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:          [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await GET()

    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('logs one gdpr.data_export.requested audit event per org for a multi-org user', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [
        { data: [{ org_id: 'org_1', role: 'manager', invite_accepted_at: '2026-01-01T00:00:00Z' }, { org_id: 'org_2', role: 'admin', invite_accepted_at: '2026-01-01T00:00:00Z' }], error: null },
      ],
      crew_members: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await GET()

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({ orgId: 'org_1', actorId: USER_ID }),
      expect.objectContaining({ orgId: 'org_2', actorId: USER_ID }),
    ])
  })
  // ── Completeness (P2-14) ──────────────────────────────────────────────────
  //
  // The history series used to be `.limit(500)` / `.limit(200)`. That is not a
  // bound on an Article 15 right-of-access response so much as a silent
  // omission from one: "all the personal data we hold about you" quietly
  // meaning "the most recent 500 events", with nothing in the payload, the
  // response or the logs saying so. These pin that the export now pages to
  // completeness and is honest when it cannot.

  it('pages the history series instead of silently capping them with .limit()', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:         [{ data: null, error: null }],
      audit_events:         [{ data: [{ action: 'auth.login', target_type: null, target_id: null, created_at: '2026-01-01T00:00:00Z' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await GET()

    const auditCalls = admin.calls.filter((c) => c.table === 'audit_events')
    expect(auditCalls.some((c) => c.method === 'range')).toBe(true)
    expect(auditCalls.some((c) => c.method === 'limit')).toBe(false)
  })

  it('orders every paged series by a UNIQUE key, not just a timestamp', async () => {
    // created_at / assigned_at are not unique. Without a tiebreak, ties can
    // straddle a page boundary and .range() paging repeats or skips them —
    // which in this route means a data-access response that is quietly wrong
    // rather than quietly short.
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:         [{ data: { id: 'cm_1' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await GET()

    const orderCols = (table: string) =>
      admin.calls.filter((c) => c.table === table && c.method === 'order').map((c) => c.args[0])

    expect(orderCols('audit_events')).toEqual(['created_at', 'id'])
    expect(orderCols('turnover_assignments')).toEqual(['assigned_at', 'turnover_id'])
  })

  it('reports completeness on a normal export, not only when something was cut', async () => {
    // A field that appears only on the unhappy path is one no consumer builds
    // against — they have never seen it, so they never check for it.
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID, email: 'pm@example.test' }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:         [{ data: null, error: null }],
      audit_events:         [{ data: [], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await GET()
    const body = JSON.parse(await res.text())

    expect(body.completeness).toEqual({
      complete: true,
      row_ceiling_per_series: 5000,
      truncated: { audit_trail: false, crew_assignments: false },
      note: null,
    })
  })

  it('DISCLOSES a truncated series rather than shipping a short export as a complete one', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)

    // Every page comes back full, so the pager keeps going until the ceiling.
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      action: 'auth.login', target_type: null, target_id: null, created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    }))
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:         [{ data: null, error: null }],
      audit_events:         Array.from({ length: 20 }, () => ({ data: fullPage, error: null })),
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await GET()
    const body = JSON.parse(await res.text())

    expect(body.completeness.complete).toBe(false)
    expect(body.completeness.truncated.audit_trail).toBe(true)
    expect(body.completeness.note).toMatch(/support@fieldstay\.app/)

    // Cut to exactly the ceiling — not one page over it, which is what a
    // length check placed after the push would produce.
    expect(body.audit_trail).toHaveLength(5000)
  })

  it('never logs the exported CONTENTS when it warns about truncation', async () => {
    // The whole payload is personal data. The operational signal is the user
    // id and which series was cut — nothing else may reach the logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID, email: 'pm@example.test' }) as never)

    const fullPage = Array.from({ length: 500 }, () => ({
      action: 'auth.login', target_type: null, target_id: 'secret-target', created_at: '2026-01-01T00:00:00Z',
    }))
    const admin = makeAdmin({
      organization_members: [{ data: [], error: null }],
      crew_members:         [{ data: null, error: null }],
      audit_events:         Array.from({ length: 20 }, () => ({ data: fullPage, error: null })),
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await GET()

    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain(USER_ID)
    expect(logged).not.toContain('secret-target')
    expect(logged).not.toContain('pm@example.test')
    warn.mockRestore()
  })
})
