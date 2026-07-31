import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}))

import { generateDepreciationLedger, depreciationLedgerOrg } from '@/lib/inngest/functions/depreciation-ledger'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// The depreciation ledger is now a DISPATCHER (`generateDepreciationLedger` —
// distinct org ids only) plus a per-org handler (`depreciationLedgerOrg`).
// The single-invocation version loaded EVERY asset platform-wide and returned
// that array as a step output, so Inngest re-sent ~45,000 rows of memoized
// state on every subsequent step, on top of running one step per tenant.
//
// This function has no `source_reference_id`-style dedup key like the
// owner_transactions writers — its idempotency guarantee instead comes from
// the UNIQUE(asset_id, tax_year) upsert target on asset_depreciation_entries
// (a re-run for the same tax year recomputes and overwrites the same row
// rather than accumulating duplicates), and a second UNIQUE(org_id,
// milestone) upsert on org_milestones for the summary. Both are asserted
// below via the exact `onConflict` option passed.

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
  id: string
  org_id: string
  property_id: string
  name: string
  asset_type: string
  placed_in_service_date: string
  purchase_price: number
  salvage_value: number | null
  macrs_class: string
}

function baseAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id:                     'asset_1',
    org_id:                 'org_1',
    property_id:            'prop_1',
    name:                   'Rooftop HVAC',
    asset_type:             'hvac',
    placed_in_service_date: '2020-06-01',
    purchase_price:         10000,
    salvage_value:          0,
    macrs_class:            '5_year',
    ...overrides,
  }
}

/**
 * `asset_depreciation_entries` is read (prior years) and then written (this
 * year) in the same handler, so its queue is: [prior-entries read, upsert].
 */
function ledgerTables(opts: {
  assets?:       Asset[]
  priorEntries?: Array<{ asset_id: string; current_year_depreciation: number }>
  upsertError?:  { message: string } | null
}): Record<string, TableSpec> {
  return {
    property_assets: [{ data: opts.assets ?? [], error: null }],
    asset_depreciation_entries: [
      { data: opts.priorEntries ?? [], error: null },
      { data: null, error: opts.upsertError ?? null },
    ],
  }
}

describe('generateDepreciationLedger (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans out one event per DISTINCT org holding eligible assets and does no ledger work itself', async () => {
    const supabase = makeSupabase({
      property_assets: [{
        data: [{ org_id: 'org_1' }, { org_id: 'org_1' }, { org_id: 'org_2' }],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateDepreciationLedger, {
      event:  {},   // cron firing — no event data
      step,
      logger: makeLogger(),
    })

    const priorYear = new Date().getFullYear() - 1
    expect(result).toEqual({ tax_year: priorYear, dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-depreciation-ledger', [
      { name: 'org/depreciation_ledger.requested', data: { org_id: 'org_1', tax_year: priorYear } },
      { name: 'org/depreciation_ledger.requested', data: { org_id: 'org_2', tax_year: priorYear } },
    ])

    // No entries are computed or written in the dispatcher — that is the whole
    // point of the split, and it is why nothing platform-wide is ever carried
    // in step state.
    const touched = new Set(supabase.calls.map((c) => c.table))
    expect([...touched]).toEqual(['property_assets'])
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('reaches orgs whose asset rows fall past the first PostgREST page', async () => {
    const rows = [
      ...Array.from({ length: 1_200 }, () => ({ org_id: 'org_early' })),
      ...Array.from({ length: 300 },   () => ({ org_id: 'org_late' })),
    ]
    const supabase = makeSupabase({ property_assets: { data: rows, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateDepreciationLedger, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ dispatched: 2 })
    const ranges = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
  })

  it('dispatches only the requested org (and year) for a manual trigger, with no platform scan', async () => {
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateDepreciationLedger, {
      event:  { data: { org_id: 'org_9', tax_year: 2024 } },
      step,
      logger: makeLogger(),
    })

    expect(result).toEqual({ tax_year: 2024, dispatched: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-depreciation-ledger', [
      { name: 'org/depreciation_ledger.requested', data: { org_id: 'org_9', tax_year: 2024 } },
    ])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('dispatches nothing when no org has an eligible asset', async () => {
    const supabase = makeSupabase({ property_assets: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(generateDepreciationLedger, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('depreciationLedgerOrg (per org)', () => {
  const event = { data: { org_id: 'org_1', tax_year: 2024 } }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes and upserts a MACRS entry for tax_year with no prior depreciation', async () => {
    const supabase = makeSupabase(ledgerTables({ assets: [baseAsset()], priorEntries: [] }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    // yearOfService = 2024 - 2020 + 1 = 5 → 5-year MACRS rate 0.1152
    // costBasis = 10000 - 0 = 10000 → currentDepr = 1152.00
    const entriesUpsert = supabase.calls.find(
      (c) => c.table === 'asset_depreciation_entries' && c.method === 'upsert',
    )!
    expect(entriesUpsert.args[0]).toEqual([
      expect.objectContaining({
        asset_id:                      'asset_1',
        org_id:                        'org_1',
        tax_year:                      2024,
        cost_basis:                    10000,
        prior_cumulative_depreciation: 0,
        current_year_depreciation:     1152,
        ending_adjusted_basis:         8848,
      }),
    ])
    expect(entriesUpsert.args[1]).toEqual({ onConflict: 'asset_id,tax_year' })

    const milestoneUpsert = supabase.calls.find(
      (c) => c.table === 'org_milestones' && c.method === 'upsert',
    )!
    expect(milestoneUpsert.args[0]).toMatchObject({
      org_id:    'org_1',
      milestone: 'depreciation_ledger_2024',
      value:     expect.objectContaining({ tax_year: 2024, entry_count: 1, total_depr: 1152 }),
    })
    expect(milestoneUpsert.args[1]).toEqual({ onConflict: 'org_id,milestone' })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', action: 'asset.depreciation_ledger.generated' }),
    )
    expect(result).toEqual({ org_id: 'org_1', tax_year: 2024, entries_written: 1 })
  })

  it('subtracts prior cumulative depreciation before computing the ending basis', async () => {
    const supabase = makeSupabase(ledgerTables({
      assets:       [baseAsset({ id: 'asset_2' })],
      priorEntries: [
        // Two prior tax years for the same asset — the map SUMS them, exactly
        // as the pre-split platform-wide version did.
        { asset_id: 'asset_2', current_year_depreciation: 1200 },
        { asset_id: 'asset_2', current_year_depreciation: 800 },
        // An entry for another asset must not leak into asset_2's cumulative.
        { asset_id: 'asset_other', current_year_depreciation: 5000 },
      ],
    }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    const entriesUpsert = supabase.calls.find(
      (c) => c.table === 'asset_depreciation_entries' && c.method === 'upsert',
    )!
    expect(entriesUpsert.args[0]).toEqual([
      expect.objectContaining({
        asset_id:                      'asset_2',
        prior_cumulative_depreciation: 2000,
        current_year_depreciation:     1152,
        ending_adjusted_basis:         10000 - 2000 - 1152,
      }),
    ])
  })

  it('scopes both the asset load and the prior-year read to its own org and to tax years before the target', async () => {
    const supabase = makeSupabase(ledgerTables({ assets: [baseAsset()] }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    const assetEqs = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
    expect(assetEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])

    const priorEqs = supabase.calls.filter((c) => c.table === 'asset_depreciation_entries' && c.method === 'eq')
    expect(priorEqs.map((c) => c.args)).toContainEqual(['org_id', 'org_1'])
    const priorLt = supabase.calls.find((c) => c.table === 'asset_depreciation_entries' && c.method === 'lt')
    expect(priorLt?.args).toEqual(['tax_year', 2024])
  })

  it('writes an entry for every asset past the first page, not just the first 1000', async () => {
    const assets = Array.from({ length: 1_750 }, (_, i) => baseAsset({ id: `asset_${i}` }))
    const supabase = makeSupabase({
      property_assets: { data: assets, error: null },
      asset_depreciation_entries: [
        { data: [], error: null },   // prior years
        { data: null, error: null }, // upsert
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toMatchObject({ entries_written: 1_750 })
    const ranges = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'range')
    expect(ranges.map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
  })

  it('is idempotent across a re-run: same conflict key, same computed entry, no accumulation', async () => {
    // Re-running the SAME tax year must recompute the identical row and land on
    // UNIQUE(asset_id, tax_year), never append a second entry. The prior-year
    // read is `tax_year < taxYear`, so the row this run just wrote is excluded
    // from the next run's cumulative — which is what stops a re-run from
    // double-counting itself.
    const runOnce = async () => {
      const supabase = makeSupabase(ledgerTables({
        assets:       [baseAsset()],
        priorEntries: [{ asset_id: 'asset_1', current_year_depreciation: 500 }],
      }))
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await invokeHandler(depreciationLedgerOrg, {
        event,
        step:   makeStep(),
        logger: makeLogger(),
      })

      const upsert = supabase.calls.find(
        (c) => c.table === 'asset_depreciation_entries' && c.method === 'upsert',
      )!
      const [entry] = upsert.args[0] as Array<Record<string, unknown>>
      return {
        result,
        onConflict: upsert.args[1],
        // `id` and `generated_at` are freshly generated per run by design (the
        // conflict target is (asset_id, tax_year), not the surrogate id).
        entry: { ...entry, id: undefined, generated_at: undefined },
      }
    }

    const first  = await runOnce()
    const second = await runOnce()

    expect(second.entry).toEqual(first.entry)
    expect(second.onConflict).toEqual({ onConflict: 'asset_id,tax_year' })
    expect(second.result).toEqual(first.result)
    expect(second.entry).toMatchObject({
      prior_cumulative_depreciation: 500,
      current_year_depreciation:     1152,
      ending_adjusted_basis:         10000 - 500 - 1152,
    })
  })

  it('writes nothing when the org has no eligible assets', async () => {
    const supabase = makeSupabase(ledgerTables({ assets: [] }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', tax_year: 2024, entries_written: 0 })
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('skips an org when every asset yields a null entry (not yet in service)', async () => {
    const supabase = makeSupabase(ledgerTables({
      assets: [baseAsset({ placed_in_service_date: '2030-01-01' })],
    }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(depreciationLedgerOrg, {
      event,
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ org_id: 'org_1', tax_year: 2024, entries_written: 0 })
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('propagates a real upsert failure instead of swallowing it', async () => {
    const supabase = makeSupabase(ledgerTables({
      assets:      [baseAsset()],
      upsertError: { message: 'connection reset' },
    }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(depreciationLedgerOrg, {
        event,
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/connection reset/)
  })

  it('surfaces a prior-year read failure instead of understating cumulative depreciation', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [baseAsset()], error: null }],
      asset_depreciation_entries: [{ data: null, error: { message: 'read timeout' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(depreciationLedgerOrg, {
        event,
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/read timeout/)

    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
  })
})
