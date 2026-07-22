import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(async () => undefined),
}))

import { dailyAssetHealth } from '@/lib/inngest/functions/cron/asset-health'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — `property_assets` and `asset_type_standards`
// are each queried more than once per run (find-assets, then per-org persist;
// standards fetch, then the bayesian-weight-nudge re-fetch), so a fixed
// per-table response isn't enough.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'eq', 'not', 'in']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('dailyAssetHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no active assets', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ assets_scored: 0 })
    // Nothing to score means the standards/repair-history/weight-nudge steps
    // never run at all.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('scores active assets per org, persists the updates, and applies no weight nudge without repair history', async () => {
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
        { data: [], error: null }, // bayesian-weight-nudge re-fetch of standards (unused, no repairs)
      ],
      work_orders: [
        { data: [], error: null },  // repair history
        { data: [], error: null },  // bayesian-weight-nudge asset repairs (none)
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ assets_scored: 1 })

    const upsertCall = supabase.calls.find((c) => c.table === 'property_assets' && c.method === 'upsert')
    expect(upsertCall).toBeDefined()
    const [persisted] = upsertCall!.args[0] as Array<{ id: string; health_score: number }>
    expect(persisted.id).toBe('asset_1')
    expect(persisted.health_score).toBeGreaterThanOrEqual(0)
    expect(persisted.health_score).toBeLessThanOrEqual(100)

    // No repair history at all → bayesian-weight-nudge bails out before
    // touching asset_type_standards.upsert.
    expect(logAuditEvents).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'asset_type_standards' && c.method === 'upsert')).toBe(false)
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
        { data: [], error: null },
      ],
      work_orders: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ assets_scored: 1 }) // still counted as "found for scoring"
    // No update produced since scoreAssets skipped the asset with no standard.
    expect(supabase.calls.some((c) => c.table === 'property_assets' && c.method === 'upsert')).toBe(false)
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

    // bayesian-weight-nudge lives inside the `activeAssets.length > 0` guard,
    // so at least one active asset must be present for it to run at all.
    const standardRow = {
      asset_type: 'hvac', age_weight: 60, condition_weight: 40,
      lifespan_min_years: 12, lifespan_max_years: 18, avg_replacement_cost_high: 7000,
    }
    const supabase = makeSupabase({
      property_assets: [
        {
          data: [{
            id: 'asset_scored', org_id: 'org_1', property_id: 'prop_1', asset_type: 'hvac',
            installation_date: '2020-01-01', expected_lifespan_years: 15,
            estimated_replacement_cost: 6000, health_score: 90,
          }],
          error: null,
        },
        { data: null, error: null }, // persist-scores upsert
      ],
      asset_type_standards: [
        { data: [standardRow], error: null }, // fetch-asset-standards (scoring)
        { data: [standardRow], error: null }, // bayesian-weight-nudge's currentStandards re-fetch
      ],
      work_orders: [
        { data: [], error: null },        // fetch-asset-repair-history (scoring) — no repairs
        { data: assetRepairs, error: null }, // bayesian-weight-nudge's own work_orders query
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyAssetHealth, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ assets_scored: 1 })

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
})
