import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { generateDepreciationLedger } from '@/lib/inngest/functions/depreciation-ledger'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// This function has no `source_reference_id`-style dedup key like the
// owner_transactions writers — its idempotency guarantee instead comes from
// the UNIQUE(asset_id, tax_year) upsert target on asset_depreciation_entries
// (a re-run for the same tax year recomputes and overwrites the same row
// rather than accumulating duplicates), and a second UNIQUE(org_id,
// milestone) upsert on org_milestones for the summary. Both are asserted
// below via the exact `onConflict` option passed.

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

function makeSupabase(opts: {
  assets?: Asset[]
  priorEntries?: Array<{ asset_id: string; current_year_depreciation: number }>
  depreciationUpsertError?: { message: string } | null
}) {
  const upsertSpy = vi.fn()
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.not    = vi.fn(() => chain)
    chain.in     = vi.fn(() => chain)
    chain.lt     = vi.fn(() => chain)
    chain.range  = vi.fn(() => chain)
    chain.upsert = vi.fn((payload: unknown, upsertOpts: unknown) => {
      upsertSpy(table, payload, upsertOpts)
      if (table === 'asset_depreciation_entries' && opts.depreciationUpsertError) {
        return Promise.resolve({ data: null, error: opts.depreciationUpsertError })
      }
      return Promise.resolve({ data: null, error: null })
    })

    if (table === 'property_assets') {
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.assets ?? [], error: null }).then(resolve)
    } else if (table === 'asset_depreciation_entries') {
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.priorEntries ?? [], error: null }).then(resolve)
    } else {
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve)
    }
    return chain
  })
  return { from, upsertSpy }
}

// Executes every step for real — every step's return value feeds later
// logic in this function (assets, prior cumulative map), so an allowlist
// stub (as used for the owner_transactions writers) would break the flow.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
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

describe('generateDepreciationLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes and upserts a MACRS entry for tax_year with no prior depreciation', async () => {
    const supabase = makeSupabase({ assets: [baseAsset()], priorEntries: [] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(generateDepreciationLedger, {
      event:  { data: { org_id: 'org_1', tax_year: 2024 } },
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // yearOfService = 2024 - 2020 + 1 = 5 → 5-year MACRS rate 0.1152
    // costBasis = 10000 - 0 = 10000 → currentDepr = 1152.00
    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'asset_depreciation_entries',
      [
        expect.objectContaining({
          asset_id:                      'asset_1',
          org_id:                        'org_1',
          tax_year:                      2024,
          cost_basis:                    10000,
          prior_cumulative_depreciation: 0,
          current_year_depreciation:     1152,
          ending_adjusted_basis:         8848,
        }),
      ],
      { onConflict: 'asset_id,tax_year' },
    )

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'org_milestones',
      expect.objectContaining({
        org_id:    'org_1',
        milestone: 'depreciation_ledger_2024',
        value:     expect.objectContaining({ tax_year: 2024, entry_count: 1, total_depr: 1152 }),
      }),
      { onConflict: 'org_id,milestone' },
    )

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org_1', action: 'asset.depreciation_ledger.generated' }),
    )
    expect(result).toEqual({ tax_year: 2024, entries_written: 1 })
  })

  it('subtracts prior cumulative depreciation before computing the ending basis', async () => {
    const supabase = makeSupabase({
      assets:       [baseAsset({ id: 'asset_2' })],
      priorEntries: [{ asset_id: 'asset_2', current_year_depreciation: 2000 }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(generateDepreciationLedger, {
      event:  { data: { org_id: 'org_1', tax_year: 2024 } },
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.upsertSpy).toHaveBeenCalledWith(
      'asset_depreciation_entries',
      [
        expect.objectContaining({
          asset_id:                      'asset_2',
          prior_cumulative_depreciation: 2000,
          current_year_depreciation:     1152,
          ending_adjusted_basis:         10000 - 2000 - 1152,
        }),
      ],
      { onConflict: 'asset_id,tax_year' },
    )
  })

  it('writes nothing when there are no eligible assets', async () => {
    const supabase = makeSupabase({ assets: [] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(generateDepreciationLedger, {
      event:  { data: { org_id: 'org_1', tax_year: 2024 } },
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ tax_year: 2024, entries_written: 0 })
  })

  it('skips an org when every asset yields a null entry (not yet in service)', async () => {
    // placed_in_service_date in the future relative to tax_year → yearOfService < 1 → null
    const supabase = makeSupabase({
      assets: [baseAsset({ placed_in_service_date: '2030-01-01' })],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(generateDepreciationLedger, {
      event:  { data: { org_id: 'org_1', tax_year: 2024 } },
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(supabase.upsertSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ tax_year: 2024, entries_written: 0 })
  })

  it('propagates a real upsert failure instead of swallowing it', async () => {
    const supabase = makeSupabase({
      assets:                   [baseAsset()],
      depreciationUpsertError:  { message: 'connection reset' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(generateDepreciationLedger, {
        event:  { data: { org_id: 'org_1', tax_year: 2024 } },
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/connection reset/)
  })
})
