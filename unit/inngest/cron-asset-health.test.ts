import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(async () => undefined),
}))

import { dailyAssetHealth, assetHealthOrg } from '@/lib/inngest/functions/cron/asset-health'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// Asset health is now a DISPATCHER (`dailyAssetHealth` — distinct org ids +
// the platform-level Bayesian weight nudge) plus a per-org scoring handler
// (`assetHealthOrg`). The single-invocation version selected every active
// property_asset platform-wide (~45,000 rows at 150 tenants) in one unbounded
// `.select()` that PostgREST silently capped at 1,000, so ~98% of assets
// stopped being rescored with no error anywhere.
//
// `property_assets` / `asset_type_standards` / `work_orders` are each queried
// more than once per run, so the shared double is seeded per table with a
// queue consumed in query order; a paginated query consumes one queue entry
// and slices it across `.range()` pages.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

const NO_NUDGE = {
  // Weight-nudge queries, in dispatcher order: work_orders (repairs in window),
  // then asset_type_standards. Empty = the nudge bails out immediately.
  work_orders:          [{ data: [], error: null }],
  asset_type_standards: [{ data: [], error: null }],
}

describe('dailyAssetHealth (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches nothing when no org has an active asset', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [], error: null }],
      ...NO_NUDGE,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('fans out one asset-health event per DISTINCT org holding active assets', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [
          { org_id: 'org_1' }, { org_id: 'org_1' }, { org_id: 'org_2' },
        ],
        error: null,
      }],
      ...NO_NUDGE,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-asset-health', [
      { name: 'org/asset_health.requested', data: { org_id: 'org_1' } },
      { name: 'org/asset_health.requested', data: { org_id: 'org_2' } },
    ])
  })

  it('reaches orgs whose asset rows fall past the first PostgREST page', async () => {
    // 1,500 asset rows: every row of page 1 belongs to org_early, and the org
    // that only appears on page 2 is exactly the tenant the pre-pagination
    // truncation silently dropped.
    const rows = [
      ...Array.from({ length: 1_200 }, () => ({ org_id: 'org_early' })),
      ...Array.from({ length: 300 },   () => ({ org_id: 'org_late' })),
    ]
    const supabase = makeSupabase({
      property_assets: { data: rows, error: null },
      ...NO_NUDGE,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-asset-health', [
      { name: 'org/asset_health.requested', data: { org_id: 'org_early' } },
      { name: 'org/asset_health.requested', data: { org_id: 'org_late' } },
    ])
  })

  it('nudges age/condition weights and batch-logs one audit event per asset type when repairs skew consistently late-life', async () => {
    // 5 completed repairs (MIN_REPAIRS), all very late in the asset's
    // expected 15-year lifespan (installed 2010, repaired 2024 → age 14,
    // 14/15 = 0.93 > 0.8 "late" cutoff) — pushes lateLifeRatio to 1.0,
    // well past the 0.6 target, producing a positive age-weight nudge.
    const assetRepairs = Array.from({ length: 5 }, (_, i) => ({
      asset_id: `asset_${i}`, actual_cost: 500, estimated_cost: 400, completed_date: '2024-06-01',
      assets: { asset_type: 'hvac', installation_date: '2010-01-01', expected_lifespan_years: 15 },
    }))

    const standardRow = {
      asset_type: 'hvac', age_weight: 60, condition_weight: 40,
      lifespan_min_years: 12, lifespan_max_years: 18, avg_replacement_cost_high: 7000,
    }
    const supabase = makeSupabase({
      property_assets:      [{ data: [{ org_id: 'org_1' }], error: null }],
      work_orders:          [{ data: assetRepairs, error: null }],
      asset_type_standards: [{ data: [standardRow], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 1 })

    const standardsUpsert = supabase.calls.find((c) => c.table === 'asset_type_standards' && c.method === 'upsert')
    expect(standardsUpsert).toBeDefined()
    const [nudged] = standardsUpsert!.args[0] as Array<{ asset_type: string; age_weight: number; condition_weight: number }>
    expect(nudged.asset_type).toBe('hvac')
    expect(nudged.age_weight).toBeGreaterThan(60)
    expect(nudged.age_weight + nudged.condition_weight).toBeCloseTo(100, 5)

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        action:     'asset.scoring_weights.auto_adjusted',
        targetType: 'asset_type_standard',
        targetId:   'hvac',
        metadata:   expect.objectContaining({ old_age_weight: 60, new_age_weight: nudged.age_weight }),
      }),
    ])
  })

  it('bounds the weight-nudge repair scan to the 3-year window instead of all work-order history', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [{ org_id: 'org_1' }], error: null }],
      ...NO_NUDGE,
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const gte = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'gte')
    expect(gte?.args[0]).toBe('completed_date')
    const windowStart = Date.parse(`${gte!.args[1] as string}T00:00:00.000Z`)
    const days = (Date.now() - windowStart) / 86_400_000
    expect(days).toBeGreaterThan(1_090)
    expect(days).toBeLessThan(1_100)
  })
})

describe('assetHealthOrg (per org)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const event = { data: { org_id: 'org_1' } }

  it('scores the org\'s active assets and persists the updates', async () => {
    const supabase = makeSupabase({
      property_assets: [
        {
          data: [{
            id: 'asset_1', org_id: 'org_1', property_id: 'prop_1', asset_type: 'hvac',
            installation_date: '2020-01-01', expected_lifespan_years: 15,
            estimated_replacement_cost: 6000, health_score: 90,
          }],
          error: null,
        },
        { data: null, error: null }, // persist-scores upsert
      ],
      asset_type_standards: [
        {
          data: [{
            asset_type: 'hvac', lifespan_min_years: 12, lifespan_max_years: 18,
            avg_replacement_cost_high: 7000, age_weight: 60, condition_weight: 40,
          }],
          error: null,
        },
      ],
      work_orders: [
        { data: [], error: null },  // repair history
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetHealthOrg, {
      event,
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', assets_scored: 1 })

    const upsertCall = supabase.calls.find((c) => c.table === 'property_assets' && c.method === 'upsert')
    expect(upsertCall).toBeDefined()
    const [persisted] = upsertCall!.args[0] as Array<{ id: string; health_score: number }>
    expect(persisted.id).toBe('asset_1')
    expect(persisted.health_score).toBeGreaterThanOrEqual(0)
    expect(persisted.health_score).toBeLessThanOrEqual(100)

    // Every query this handler runs is scoped to the dispatched org.
    const assetEqs = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
    expect(assetEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])
    const woEqs = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'eq')
    expect(woEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])
  })

  it('is a no-op when the org has no active assets', async () => {
    const supabase = makeSupabase({ property_assets: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetHealthOrg, {
      event,
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', assets_scored: 0 })
    // Nothing to score means the standards/repair-history queries never run.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('skips scoring an asset whose asset_type has no matching standard row', async () => {
    const supabase = makeSupabase({
      property_assets: [
        {
          data: [{
            id: 'asset_orphan', org_id: 'org_1', property_id: 'prop_1', asset_type: 'generator',
            installation_date: '2021-01-01', expected_lifespan_years: 20,
            estimated_replacement_cost: 3000, health_score: null,
          }],
          error: null,
        },
      ],
      asset_type_standards: [
        { data: [], error: null }, // no standards at all — nothing matches 'generator'
      ],
      work_orders: [
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetHealthOrg, {
      event,
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // assets_scored now reports assets actually SCORED (updates.length), not
    // assets merely found — the pre-split version returned the candidate count,
    // which reported 1 for an asset it had in fact skipped.
    expect(result).toEqual({ org_id: 'org_1', assets_scored: 0 })
    expect(supabase.calls.some((c) => c.table === 'property_assets' && c.method === 'upsert')).toBe(false)
  })

  it('scores every asset past the first page, not just the first 1000', async () => {
    const assets = Array.from({ length: 1_750 }, (_, i) => ({
      id: `asset_${i}`, org_id: 'org_1', property_id: 'prop_1', asset_type: 'hvac',
      installation_date: '2020-01-01', expected_lifespan_years: 15,
      estimated_replacement_cost: 6000, health_score: 90,
    }))
    const supabase = makeSupabase({
      // Fixed spec: `.range()` really slices it, so fetchAllRows drains two pages.
      property_assets: { data: assets, error: null },
      asset_type_standards: [{
        data: [{
          asset_type: 'hvac', lifespan_min_years: 12, lifespan_max_years: 18,
          avg_replacement_cost_high: 7000, age_weight: 60, condition_weight: 40,
        }],
        error: null,
      }],
      work_orders: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetHealthOrg, {
      event,
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', assets_scored: 1_750 })
    const ranges = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
  })
})
