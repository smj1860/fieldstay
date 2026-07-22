import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { triggerCapexProjectionForOrg } from '@/lib/inngest/functions/capex-projection-trigger'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

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

// Table results are keyed statically (not queue-based) since this function
// issues exactly one Promise.all of three reads per invocation, no re-reads
// — mirrors capex-projections.test.ts's makeSupabase (the monthly-cron
// sibling of this on-demand function).
function makeSupabase(opts: {
  assets?:     Asset[]
  standards?:  Array<{ asset_type: string; lifespan_min_years: number; lifespan_max_years: number; avg_replacement_cost_low: number; avg_replacement_cost_high: number }>
  properties?: Array<{ id: string; name: string }>
}) {
  const upsertSpy = vi.fn()
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.not    = vi.fn(() => chain)
    chain.upsert = vi.fn((payload: unknown, upsertOpts: unknown) => {
      upsertSpy(table, payload, upsertOpts)
      return Promise.resolve({ data: null, error: null })
    })

    const byTable: Record<string, unknown> = {
      property_assets:      opts.assets ?? [],
      asset_type_standards: opts.standards ?? [],
      properties:           opts.properties ?? [],
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: byTable[table] ?? [], error: null }).then(resolve)
    return chain
  })
  return { from, upsertSpy }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
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

describe('triggerCapexProjectionForOrg', () => {
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
      assets:     [baseAsset()],
      properties: [{ id: 'prop_1', name: 'Lake House' }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    // age 10, lifespan 15 → yearsLeft 5 → replacementYear 2026 + 5 = 2031
    expect(result).toEqual({ org_id: 'org_1', years_with_items: 1, total_assets: 1 })

    const [, payload] = supabase.upsertSpy.mock.calls.find((call: unknown[]) => call[0] === 'org_milestones')!
    expect(payload).toMatchObject({ org_id: 'org_1', milestone: 'capex_projection_2026' })
    const projections = (payload as { value: { projections: Record<number, unknown> } }).value.projections
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
      assets: [baseAsset({ id: 'asset_far', installation_date: '2024-01-01', expected_lifespan_years: 15 })],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', years_with_items: 0, total_assets: 1 })
    const [, payload] = supabase.upsertSpy.mock.calls.find((call: unknown[]) => call[0] === 'org_milestones')!
    const projections = (payload as { value: { projections: Record<number, unknown> } }).value.projections
    expect(Object.keys(projections)).toHaveLength(0)
  })

  it('is a no-op — zero years with items, still upserts an empty projection — when the org has no assets', async () => {
    const supabase = makeSupabase({ assets: [] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(triggerCapexProjectionForOrg, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', years_with_items: 0, total_assets: 0 })
    expect(supabase.upsertSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to asset_type_standards for lifespan and cost when the asset has none of its own', async () => {
    const supabase = makeSupabase({
      assets: [
        baseAsset({
          id:                         'asset_std',
          expected_lifespan_years:    null,
          estimated_replacement_cost: null,
        }),
      ],
      standards: [
        {
          asset_type:                'water_heater',
          lifespan_min_years:        10,
          lifespan_max_years:        14, // avg 12 → yearsLeft = 12 - 10 = 2 → replacementYear 2028
          avg_replacement_cost_low:  900,
          avg_replacement_cost_high: 1100,
        },
      ],
      properties: [{ id: 'prop_1', name: 'Lake House' }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(triggerCapexProjectionForOrg, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    const [, payload] = supabase.upsertSpy.mock.calls.find((call: unknown[]) => call[0] === 'org_milestones')!
    const projections = (payload as { value: { projections: Record<number, unknown> } }).value.projections
    expect(projections[2028]).toMatchObject({ total_low: 900, total_high: 1100 })
  })

  it('upserts on the (org_id, milestone) conflict key so a re-fire for the same org/year overwrites rather than duplicates', async () => {
    const supabase = makeSupabase({
      assets:     [baseAsset()],
      properties: [{ id: 'prop_1', name: 'Lake House' }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(triggerCapexProjectionForOrg, {
      event:  { data: { org_id: 'org_1' } },
      step:   makeStep(),
      logger: makeLogger(),
    })

    const [, , upsertOpts] = supabase.upsertSpy.mock.calls.find((call: unknown[]) => call[0] === 'org_milestones')!
    expect(upsertOpts).toEqual({ onConflict: 'org_id,milestone' })
  })
})
