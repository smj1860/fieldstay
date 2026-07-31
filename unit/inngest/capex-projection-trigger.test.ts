import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { triggerCapexProjectionForOrg } from '@/lib/inngest/functions/capex-projection-trigger'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// The on-demand button and the monthly cron's per-org handler now share
// runCapexProjectionForOrg (lib/inngest/functions/capex-projection-core.ts), so
// the two paths cannot drift into producing different org_milestones payloads
// for the same org. These tests pin the on-demand path's own contract: its
// return shape, its org scoping, and the (org_id, milestone) conflict key.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
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

function milestoneUpsert(supabase: ReturnType<typeof createSupabaseDouble>) {
  const call = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
  expect(call).toBeDefined()
  return call!
}

describe('triggerCapexProjectionForOrg', () => {
  const event = { data: { org_id: 'org_1' } }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('buckets an asset within the 10-year horizon into its replacement year and upserts the org milestone', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [baseAsset()], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    // age 10, lifespan 15 → yearsLeft 5 → replacementYear 2026 + 5 = 2031
    expect(result).toEqual({ org_id: 'org_1', years_with_items: 1, total_assets: 1 })

    const upsert = milestoneUpsert(supabase)
    expect(upsert.args[0]).toMatchObject({ org_id: 'org_1', milestone: 'capex_projection_2026' })
    const projections = (upsert.args[0] as { value: { projections: Record<number, unknown> } }).value.projections
    expect(projections[2031]).toMatchObject({
      total_low:  1200,
      total_high: 1200,
      items: [
        expect.objectContaining({
          asset_id:         'asset_1',
          property_name:    'Lake House',
          replacement_year: 2031,
          cost_low:         1200,
          cost_high:        1200,
          age_years:        10,
        }),
      ],
    })
  })

  it('excludes an asset with more than 10 years of remaining life and returns zero years with items', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [baseAsset({ id: 'asset_far', installation_date: '2024-01-01', expected_lifespan_years: 15 })],
        error: null,
      }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', years_with_items: 0, total_assets: 1 })
    const upsert = milestoneUpsert(supabase)
    const projections = (upsert.args[0] as { value: { projections: Record<number, unknown> } }).value.projections
    expect(Object.keys(projections)).toHaveLength(0)
  })

  it('is a no-op — zero years with items, still upserts an empty projection — when the org has no assets', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', years_with_items: 0, total_assets: 0 })
    expect(supabase.calls.filter((c) => c.table === 'org_milestones' && c.method === 'upsert')).toHaveLength(1)
  })

  it('falls back to asset_type_standards for lifespan and cost when the asset has none of its own', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [baseAsset({ id: 'asset_std', expected_lifespan_years: null, estimated_replacement_cost: null })],
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

    await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    const upsert = milestoneUpsert(supabase)
    const projections = (upsert.args[0] as { value: { projections: Record<number, unknown> } }).value.projections
    expect(projections[2028]).toMatchObject({ total_low: 900, total_high: 1100 })
  })

  it('upserts on the (org_id, milestone) conflict key so a re-fire for the same org/year overwrites rather than duplicates', async () => {
    const supabase = makeSupabase({
      property_assets:      [{ data: [baseAsset()], error: null }],
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(milestoneUpsert(supabase).args[1]).toEqual({ onConflict: 'org_id,milestone' })
  })

  it('paginates the on-demand asset scan too — an org past 1000 assets is projected in full', async () => {
    const assets = Array.from({ length: 1_200 }, (_, i) => baseAsset({ id: `asset_${i}` }))
    const supabase = makeSupabase({
      property_assets:      { data: assets, error: null },
      asset_type_standards: [{ data: [], error: null }],
      properties:           [{ data: [{ id: 'prop_1', name: 'Lake House' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', years_with_items: 1, total_assets: 1_200 })
  })
})
