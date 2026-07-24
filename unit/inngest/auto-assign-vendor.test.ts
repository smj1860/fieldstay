import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { autoAssignVendor } from '@/lib/inngest/functions/auto-assign-vendor'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Every step actually runs — auto-assign-vendor.ts has no email/SMS/audit
// side effects, only Supabase reads/writes, so a bare pass-through step stub
// (matching on-failure.test.ts's makeStep()) is enough to exercise the real
// scoring + write logic end to end.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

interface QueuedByTable {
  [table: string]: unknown[]
}

// Queue-based `.from(table)` mock: each call to `.from(table)` consumes the
// next queued response for that table, regardless of which terminal method
// (`.single()`, `.maybeSingle()`, or a bare `await`) resolves it. `calls`
// records every filter/write invocation for assertions about exactly what
// was queried or written — see unit/owner-portal/load-owner-portal-data.test.ts
// for the same pattern.
function makeSupabase(queued: QueuedByTable) {
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
    chain.neq    = (...a: unknown[]) => record('neq', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

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

const ORG_ID      = 'org_1'
const PROPERTY_ID = 'prop_1'
const WO_ID       = 'wo_1'

function baseEvent() {
  return {
    data: { work_order_id: WO_ID, property_id: PROPERTY_ID, org_id: ORG_ID, category: 'plumbing' },
  }
}

describe('autoAssignVendor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SAFETY: excludes a hard-blocked vendor entirely — no suggestion is written when the only candidate is hard-blocked', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { vendor_auto_assign_mode: 'suggest' }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0 }, error: null }],
      vendors: [{
        data: [{ id: 'v_blocked', name: 'Blocked Plumbing Co', lat: 30.01, lng: -90.01, avg_rating: 4.5 }],
        error: null,
      }],
      vendor_compliance_status: [{
        data: [{ vendor_id: 'v_blocked', compliance_status: 'hard_blocked' }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignVendor, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ skipped: true, reason: 'disabled or no candidates' })
    // The compliance-filter early return happens before the familiarity/workload
    // work_orders queries — no work_orders lookup and no write of any kind.
    expect(supabase.calls.some((c) => c.table === 'work_orders')).toBe(false)
    expect(supabase.calls.some((c) => c.method === 'update' || c.method === 'upsert')).toBe(false)
  })

  it('SAFETY: a compliant vendor is suggested over a hard-blocked one when both match the specialty', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { vendor_auto_assign_mode: 'suggest' }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0 }, error: null }],
      vendors: [{
        data: [
          { id: 'v_blocked',   name: 'Blocked Plumbing Co',   lat: 30.001, lng: -90.001, avg_rating: 5.0 },
          { id: 'v_compliant', name: 'Reliable Plumbing Inc', lat: 30.5,   lng: -90.5,    avg_rating: 4.0 },
        ],
        error: null,
      }],
      vendor_compliance_status: [{
        data: [{ vendor_id: 'v_blocked', compliance_status: 'hard_blocked' }],
        error: null,
      }],
      // Only v_compliant survives the compliance filter, so the familiarity/
      // workload queries scope `.in('vendor_id', ...)` to just that vendor.
      work_orders: [
        { data: [], error: null }, // pastWOs
        { data: [], error: null }, // openWOs
      ],
      vendor_assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignVendor, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'suggested', top_vendor: 'Reliable Plumbing Inc' })

    const suggestionWrite = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(suggestionWrite?.args[0]).toMatchObject({ suggested_vendor_ids: ['v_compliant'] })
  })

  it('grace_period vendor is still assignable but penalized (0.7x) rather than hard-excluded, per COMPLIANCE_FACTOR', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { vendor_auto_assign_mode: 'suggest' }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0 }, error: null }],
      vendors: [{
        data: [{ id: 'v_grace', name: 'Grace Period Vendor', lat: 30.0, lng: -90.0, avg_rating: 5.0 }],
        error: null,
      }],
      vendor_compliance_status: [{
        data: [{ vendor_id: 'v_grace', compliance_status: 'grace_period' }],
        error: null,
      }],
      work_orders: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      vendor_assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignVendor, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ action: 'suggested', top_vendor: 'Grace Period Vendor' })

    const outcomeUpsert = supabase.calls.find((c) => c.table === 'vendor_assignment_outcomes' && c.method === 'upsert')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = outcomeUpsert?.args[0] as any
    expect(payload.score_breakdown.complianceFactor).toBe(0.7)
    // Idempotency-safe write shape — a redelivered event upserts the same
    // (work_order_id, vendor_id) row instead of inserting a duplicate.
    expect(outcomeUpsert?.args[1]).toEqual({ onConflict: 'work_order_id,vendor_id' })
  })

  it('does nothing when vendor_auto_assign_mode is not "suggest"', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { vendor_auto_assign_mode: 'disabled' }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0 }, error: null }],
      vendors: [{
        data: [{ id: 'v1', name: 'Some Vendor', lat: 30.0, lng: -90.0, avg_rating: 4.0 }],
        error: null,
      }],
      vendor_compliance_status: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(autoAssignVendor, { event: baseEvent(), step: makeStep() })

    expect(result).toEqual({ skipped: true, reason: 'disabled or no candidates' })
    expect(supabase.calls.some((c) => c.method === 'update' || c.method === 'upsert')).toBe(false)
  })

  it('scopes the vendor candidate query to the work order category, org, and active vendors only', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: { vendor_auto_assign_mode: 'suggest' }, error: null }],
      properties:    [{ data: { id: PROPERTY_ID, lat: 30.0, lng: -90.0 }, error: null }],
      vendors: [{
        data: [{ id: 'v1', name: 'Plumber One', lat: 30.0, lng: -90.0, avg_rating: 4.0 }],
        error: null,
      }],
      vendor_compliance_status: [{ data: [], error: null }],
      work_orders: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      vendor_assignment_outcomes: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(autoAssignVendor, { event: baseEvent(), step: makeStep() })

    const vendorEqCalls = supabase.calls.filter((c) => c.table === 'vendors' && c.method === 'eq')
    const eqArgs = vendorEqCalls.map((c) => c.args)
    expect(eqArgs).toContainEqual(['org_id', ORG_ID])
    expect(eqArgs).toContainEqual(['specialty', 'plumbing'])
    expect(eqArgs).toContainEqual(['is_active', true])
  })
})
