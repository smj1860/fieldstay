import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))

import { generateCapexProjections, capexProjectionOrg } from '@/lib/inngest/functions/capex-projections'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// CapEx projection is now a DISPATCHER (`generateCapexProjections` — distinct
// org ids, one event each) plus a per-org handler (`capexProjectionOrg`). The
// single-invocation version ran one `step.run` per tenant inside one Inngest
// run, and its per-org `property_assets` select had no pagination at all, so a
// tenant past PostgREST's 1000-row cap silently lost assets from the plan.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface Asset {
  id:                          string
  name:                        string
  asset_type:                  string
  property_id:                 string
  installation_date:           string | null
  expected_lifespan_years:     number | null
  estimated_replacement_cost:  number | null
  health_score:                number | null
}

function baseAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id:                         'asset_1',
    name:                       'Water Heater',
    asset_type:                 'water_heater',
    property_id:                'prop_1',
    installation_date:          '2016-01-01', // age 10 as of 2026
    expected_lifespan_years:    15,
    estimated_replacement_cost: 1200,
    health_score:               40,
    ...overrides,
  }
}

function milestonePayload(supabase: ReturnType<typeof createSupabaseDouble>) {
  const call = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
  expect(call).toBeDefined()
  return call!
}

describe('generateCapexProjections (dispatcher)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('dispatches nothing when there are no organizations', async () => {
    const supabase = makeSupabase({ organizations: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateCapexProjections, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 0, tax_year: 2026 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('fans out one event per org and does NOT do the projection work itself', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: [{ id: 'org_1' }, { id: 'org_2' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateCapexProjections, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 2, tax_year: 2026 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-capex-projections', [
      { name: 'org/capex_projection.requested', data: { org_id: 'org_1', year: 2026 } },
      { name: 'org/capex_projection.requested', data: { org_id: 'org_2', year: 2026 } },
    ])

    // The whole point of the conversion: the dispatcher touches no per-org
    // table and writes no milestone — that is the handler's job, one run each.
    const touched = new Set(supabase.calls.map((c) => c.table))
    expect([...touched]).toEqual(['organizations'])
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('dispatches orgs that fall past the first PostgREST page', async () => {
    const orgs = Array.from({ length: 1_500 }, (_, i) => ({ id: `org_${i}` }))
    const supabase = makeSupabase({ organizations: { data: orgs, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateCapexProjections, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ dispatched: 1_500, tax_year: 2026 })
    const ranges = supabase.calls.filter((c) => c.table === 'organizations' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])

    const [, events] = step.sendEvent.mock.calls[0]! as [string, Array<{ data: { org_id: string } }>]
    expect(events).toHaveLength(1_500)
    expect(events[1_499]!.data.org_id).toBe('org_1499')
  })
})

describe('capexProjectionOrg (per org)', () => {
  const event = { data: { org_id: 'org_1', year: 2026 } }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('buckets an asset within 10 years of end-of-life into its replacement year', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [baseAsset()], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    // age 10, lifespan 15 → yearsLeft 5 → replacementYear 2026 + 5 = 2031
    expect(result).toEqual({ org_id: 'org_1', tax_year: 2026, years_with_items: 1, total_assets: 1 })

    const upsert = milestonePayload(supabase)
    expect(upsert.args[0]).toMatchObject({ org_id: 'org_1', milestone: 'capex_projection_2026' })
    const projections = (upsert.args[0] as { value: { projections: Record<number, unknown> } }).value.projections
    expect(projections[2031]).toMatchObject({
      total_low:  1200,
      total_high: 1200,
      items: [
        expect.objectContaining({
          asset_id:         'asset_1',
          property_id:      'prop_1',
          property_name:    'Lake House',
          replacement_year: 2031,
          cost_low:         1200,
          cost_high:        1200,
          age_years:        10,
          pct_of_lifespan:  67,
          health_score:     40,
        }),
      ],
    })

    // UNIQUE (org_id, milestone) — a retry overwrites rather than duplicates.
    expect(upsert.args[1]).toEqual({ onConflict: 'org_id,milestone' })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', action: 'asset.capex_projection.triggered' }),
    )
  })

  it('scopes every read to its own org', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [baseAsset()], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    const assetEqs = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
    expect(assetEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])
    const propEqs = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(propEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])

    // asset_type_standards is a GLOBAL 21-row reference table: bounded, not
    // org-scoped, and read exactly ONCE per invocation (it used to be
    // re-fetched inside every iteration of the platform-wide org loop).
    const standardsSelects = supabase.calls.filter((c) => c.table === 'asset_type_standards' && c.method === 'select')
    expect(standardsSelects).toHaveLength(1)
    const standardsLimit = supabase.calls.find((c) => c.table === 'asset_type_standards' && c.method === 'limit')
    expect(standardsLimit).toBeDefined()
  })

  it('projects every asset past the first page, not just the first 1000', async () => {
    // The pre-conversion per-org select had no .range() at all, so an org with
    // more than 1000 eligible assets silently lost the remainder from its plan.
    const assets = Array.from({ length: 1_750 }, (_, i) => baseAsset({ id: `asset_${i}` }))
    const supabase = makeSupabase({
      property_assets:      { data: assets, error: null },
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ total_assets: 1_750, years_with_items: 1 })
    const ranges = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])

    const upsert = milestonePayload(supabase)
    const projections = (upsert.args[0] as { value: { projections: Record<number, { items: unknown[] }> } }).value.projections
    expect(projections[2031]!.items).toHaveLength(1_750)
  })

  it('excludes an asset with more than 10 years of remaining life', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [baseAsset({ id: 'asset_far', installation_date: '2024-01-01', expected_lifespan_years: 15 })],
        error: null,
      }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ years_with_items: 0, total_assets: 1 })
  })

  it('skips assets with no installation_date without crashing', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [baseAsset({ installation_date: null })], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ years_with_items: 0 })
  })

  it('falls back to asset_type_standards for lifespan and cost when the asset has none', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [baseAsset({ expected_lifespan_years: null, estimated_replacement_cost: null })],
        error: null,
      }],
      asset_type_standards: [{
        data: [{
          asset_type:                'water_heater',
          lifespan_min_years:        10,
          lifespan_max_years:        14, // avg 12 → yearsLeft = 12 - 10 = 2 → 2028
          avg_replacement_cost_low:  900,
          avg_replacement_cost_high: 1100,
        }],
        error: null,
      }],
      properties: [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(capexProjectionOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    const upsert = milestonePayload(supabase)
    const projections = (upsert.args[0] as { value: { projections: Record<number, unknown> } }).value.projections
    expect(projections[2028]).toMatchObject({ total_low: 900, total_high: 1100 })
  })

  it('surfaces a paginated read failure instead of writing a truncated projection', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: null, error: { message: 'connection reset' } }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(capexProjectionOrg, {
        event,
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/connection reset/)

    expect(supabase.calls.some((c) => c.table === 'org_milestones')).toBe(false)
  })
})
