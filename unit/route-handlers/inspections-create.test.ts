import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// "At most one open inspection per schedule" used to be enforced ONLY by a
// read-time filter (lib/inspections/due-schedules.ts) over cached rows. Two
// devices — or one device racing a double-tap before its own cache
// re-renders — can each mint a fresh inspection id against the same
// source_schedule_id; the route's upsert only dedups on `id`
// (onConflict: 'id'), which does nothing for two genuinely different ids.
//
// inspections_one_open_walk_per_schedule (a partial UNIQUE index) closes
// that at the database. This tests the route's handling of the resulting
// 23505: the walk itself must still be created (the answers are real and on
// a tablet) with the schedule link dropped, not dead-lettered.
// ============================================================================

vi.mock('@/lib/auth', () => ({ requireOrgRole: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/tenancy/verify', () => ({ verifyPropertyInOrg: vi.fn() }))
vi.mock('@/lib/inngest/helpers', () => ({ getPmMembers: vi.fn(async () => []) }))
vi.mock('@/lib/weather/tomorrow', () => ({ getWeatherForLocation: vi.fn() }))
vi.mock('@/lib/inspections/start-time', () => ({
  resolveStartTime: vi.fn(() => ({ startedAt: '2026-09-15T10:00:00.000Z', offsetSeconds: 0 })),
}))
vi.mock('@/lib/inspections/snapshots', () => ({
  buildHeaderSnapshot: vi.fn(() => ({ property_name: 'p' })),
  parseFormSnapshot:   vi.fn(() => ({ form_key: 'safety', form_version: 1, captured_at: '', sections: [] })),
  recordedConditions:  vi.fn(() => null),
  reportedConditions:  vi.fn(() => null),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }))

import { POST } from '@/app/api/inspections/route'
import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { reportError } from '@/lib/observability/report-error'

const ORG  = 'org-1'
const USER = 'user-1'

function req(body: Record<string, unknown>) {
  return new Request('https://app.example.test/api/inspections', {
    method: 'POST', body: JSON.stringify(body),
  })
}

function body(over: Record<string, unknown> = {}) {
  // Relative to the clock at test-run time, not a hardcoded date — a fixed
  // absolute timestamp here ages past MAX_PLAUSIBLE_OFFSET_SECONDS (24h) as
  // soon as real time moves a day beyond whenever this file was written,
  // turning every test that doesn't override these fields into a 400 from
  // the device-clock-plausibility guard rather than what it's actually
  // testing.
  const now = new Date().toISOString()
  return {
    id: 'insp-1', property_id: 'prop-1', form_id: 'form-1', form_version: 1,
    form_snapshot: {}, device_started_at: now,
    device_now: now, source_schedule_id: 'sched-1',
    ...over,
  }
}

/** A Supabase double whose `inspections` upsert answers from a queue, one call at a time. */
function makeSupabase(opts: {
  upsertResults: Array<{ error: unknown }>
  scheduleId?: string | null
}) {
  const upsertCalls: unknown[] = []
  let upsertCall = 0

  // Each table gets a SELF-CONTAINED chain — select()/eq() return the SAME
  // object so maybeSingle() stays reachable after either call.
  function makeChain(data: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = {}
    self.select = () => self
    self.eq = () => self
    self.maybeSingle = () => Promise.resolve({ data, error: null })
    return self
  }

  const from = vi.fn((table: string) => {
    if (table === 'inspections') {
      return {
        upsert: (payload: unknown) => {
          upsertCalls.push(payload)
          const result = opts.upsertResults[upsertCall] ?? opts.upsertResults.at(-1)!
          upsertCall += 1
          return Promise.resolve(result)
        },
      }
    }
    if (table === 'maintenance_schedules') {
      return makeChain(
        opts.scheduleId === undefined ? { id: 'sched-1' } : (opts.scheduleId ? { id: opts.scheduleId } : null),
      )
    }
    if (table === 'properties') {
      return makeChain({ name: 'p', address: 'a', city: 'c', state: 's', zip: 'z', lat: null, lng: null })
    }
    if (table === 'profiles') {
      return makeChain(null)
    }
    throw new Error(`unexpected table ${table}`)
  })

  return { from, upsertCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyPropertyInOrg).mockResolvedValue({ ok: true } as never)
})

describe('POST /api/inspections — schedule-collision retry', () => {
  it('drops the schedule link and retries once when the schedule is already claimed', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "inspections_one_open_walk_per_schedule"' } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body()))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(supabase.upsertCalls).toHaveLength(2)
    expect((supabase.upsertCalls[0] as { source_schedule_id: unknown }).source_schedule_id).toBe('sched-1')
    expect((supabase.upsertCalls[1] as { source_schedule_id: unknown }).source_schedule_id).toBeNull()
  })

  it('records schedule_link_dropped on the audit event when it happens', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "inspections_one_open_walk_per_schedule"' } },
        { error: null },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    await POST(req(body()))

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ schedule_link_dropped: true }) }),
    )
  })

  it('does NOT retry (and does not claim schedule_link_dropped) on an ordinary successful create', async () => {
    const supabase = makeSupabase({ upsertResults: [{ error: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body()))
    expect(res.status).toBe(200)
    expect(supabase.upsertCalls).toHaveLength(1)
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.not.objectContaining({ schedule_link_dropped: true }) }),
    )
  })

  it('does NOT retry on a DIFFERENT 23505 — a real, unexpected constraint violation must still fail loud', async () => {
    const supabase = makeSupabase({
      upsertResults: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint "some_other_constraint"' } }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body()))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.ok).toBe(false)
    expect(supabase.upsertCalls).toHaveLength(1)
    expect(reportError).toHaveBeenCalled()
  })

  it('a genuinely-failed retry still reports and 500s (outbox retries) rather than claiming success', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "inspections_one_open_walk_per_schedule"' } },
        { error: { code: '08006', message: 'connection reset' } },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body()))
    expect(res.status).toBe(500)
    expect(supabase.upsertCalls).toHaveLength(2)
  })
})

// ============================================================================
// idx_inspections_one_open_draft: at most one OPEN inspection per
// (property_id, form_id). Unlike the schedule conflict above, this cannot be
// safely absorbed by dropping a field and re-inserting under the same id —
// the answers on the LOSING device are real, distinct work, and silently
// returning success without a row for this id would mean its later
// inspection_items sync has no parent to attach to, discarding that work
// with no trace. So this must be a TERMINAL 409 — not retried by the outbox,
// not silently swallowed as success — surfaced through the same dead-letter
// path every other terminal outbox failure uses.
// ============================================================================
describe('POST /api/inspections — one-open-draft-per-property-and-form conflict', () => {
  it('returns a terminal 409 rather than retrying or claiming success', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_inspections_one_open_draft"' } },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body()))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.ok).toBe(false)
    // Exactly one attempt — no silent retry that could paper over the
    // conflict, and no second insert under a modified payload the way the
    // schedule-collision case retries with source_schedule_id dropped.
    expect(supabase.upsertCalls).toHaveLength(1)
  })

  it('reports the conflict as a warning-level signal, not a hard error', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_inspections_one_open_draft"' } },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    await POST(req(body()))

    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        site: 'route.inspections.create.duplicate_open_draft',
        level: 'warning',
      }),
    )
  })

  it('does NOT log an audit event for a rejected duplicate-draft create', async () => {
    const supabase = makeSupabase({
      upsertResults: [
        { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_inspections_one_open_draft"' } },
      ],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    await POST(req(body()))

    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

describe('POST /api/inspections — device clock plausibility', () => {
  // MAX_PLAUSIBLE_OFFSET_SECONDS used to be 10 years, which accepted exactly
  // the realistic "broken device" case it was meant to catch: a dead-CMOS
  // tablet whose clock reset a few years off. Now 1 day.
  it('rejects a device_now offset by years, not just multiple decades', async () => {
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString()
    const supabase = makeSupabase({ upsertResults: [{ error: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body({ device_started_at: threeYearsAgo, device_now: threeYearsAgo })))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.ok).toBe(false)
    expect(supabase.upsertCalls).toHaveLength(0)
  })

  it('accepts an offset within a day, the expected offline-reconnect window', async () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
    const supabase = makeSupabase({ upsertResults: [{ error: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({
      supabase, membership: { org_id: ORG, org: { name: 'Org' } }, user: { id: USER },
    } as never)

    const res = await POST(req(body({ device_started_at: twelveHoursAgo, device_now: twelveHoursAgo })))

    expect(res.status).toBe(200)
    expect(supabase.upsertCalls).toHaveLength(1)
  })
})
