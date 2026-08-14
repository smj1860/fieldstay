import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requireOrgMember: vi.fn() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/app/(dashboard)/capital-planning/trigger-ledger-button',      () => ({ TriggerLedgerButton: () => null }))
vi.mock('@/app/(dashboard)/capital-planning/trigger-projections-button', () => ({ TriggerProjectionsButton: () => null }))
vi.mock('@/app/(dashboard)/capital-planning/status-dropdown',            () => ({ StatusDropdown: () => null }))
vi.mock('@/app/(dashboard)/capital-planning/property-filter-select',     () => ({ PropertyFilterSelect: () => null }))

import CapitalPlanningPage from '@/app/(dashboard)/capital-planning/page'
import { requireOrgMember } from '@/lib/auth'

// ============================================================================
// The replacement-status read must be scoped to what is ON SCREEN.
//
// It began as `.select()` over every non-`projected` asset in the org, on a
// user-facing render. An earlier pass bounded it with
// `.limit(SUPABASE_MAX_ROWS)` — but SUPABASE_MAX_ROWS *is* PostgREST's own cap,
// so that did not add a bound so much as make the existing one explicit. Past
// it, the page did not error: assets beyond the cap fell out of
// `statusByAsset` and rendered as the default "Projected" regardless of being
// budgeted, approved or deferred. Silently wrong financial state.
//
// Scoping to the rendered ids is what actually fixes it, and these tests pin
// the three properties that make that true: the read is filtered by id, it
// covers every rendered id, and it never asks for ids that are not rendered.
// ============================================================================

const ORG = 'org_1'

interface Call { table: string; method: string; args: unknown[] }

function makeSupabase(rows: Record<string, unknown[]>) {
  const calls: Call[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => record(m, a)
    }
    const settle = () => Promise.resolve({ data: rows[table] ?? [], error: null })
    chain.maybeSingle = () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null })
    chain.single = () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null })
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej)
    return chain
  })

  return { from, calls }
}

/** A complete CapExProjectionItem — the page renders these, so a partial
 *  fixture fails on a field the query change has nothing to do with. */
function item(asset_id: string, property_id = 'prop_1') {
  return {
    asset_id,
    asset_name:       `Asset ${asset_id}`,
    property_id,
    property_name:    'Lakehouse',
    asset_type:       'hvac',
    replacement_year: new Date().getFullYear(),
    cost_low:         100,
    cost_high:        200,
    health_score:     50,
    age_years:        5,
    pct_of_lifespan:  40,
  }
}

/** A capex milestone payload with one projected item per supplied asset id. */
function milestoneFor(assetIds: string[], propertyId = 'prop_1') {
  const year = new Date().getFullYear()
  return {
    value: {
      projections: {
        [year]: {
          total_low:  0,
          total_high: 0,
          items: assetIds.map((id) => item(id, propertyId)),
        },
      },
    },
    achieved_at: new Date().toISOString(),
  }
}

async function renderPage(
  supabase: ReturnType<typeof makeSupabase>,
  searchParams: { property?: string } = {},
) {
  vi.mocked(requireOrgMember).mockResolvedValue({
    supabase, membership: { org_id: ORG },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  await CapitalPlanningPage({ searchParams: Promise.resolve(searchParams) })
}

/** Every `.in('id', …)` issued against property_assets, flattened. */
function requestedAssetIds(supabase: ReturnType<typeof makeSupabase>): string[] {
  return supabase.calls
    .filter((c) => c.table === 'property_assets' && c.method === 'in' && c.args[0] === 'id')
    .flatMap((c) => c.args[1] as string[])
}

beforeEach(() => vi.clearAllMocks())

describe('CapitalPlanningPage — replacement-status read', () => {
  it('asks only for the assets it is about to render', async () => {
    const supabase = makeSupabase({
      org_milestones: [milestoneFor(['a1', 'a2', 'a3'])],
      properties:     [{ id: 'prop_1', name: 'Lakehouse' }],
      property_assets: [],
    })

    await renderPage(supabase)

    expect(requestedAssetIds(supabase).sort()).toEqual(['a1', 'a2', 'a3'])

    // And never the org-wide sweep it replaced: no `.neq('replacement_status',
    // 'projected')` scan of every asset in the portfolio.
    const sweeps = supabase.calls.filter(
      (c) => c.table === 'property_assets' && c.method === 'neq',
    )
    expect(sweeps).toEqual([])
  })

  it('is still org-scoped — the id list is not the only filter', async () => {
    // The ids come out of a stored milestone payload. Scoping by id ALONE would
    // make a stale or tampered payload able to read another tenant's assets.
    const supabase = makeSupabase({
      org_milestones: [milestoneFor(['a1'])],
      properties:     [{ id: 'prop_1', name: 'Lakehouse' }],
      property_assets: [],
    })

    await renderPage(supabase)

    const orgFilters = supabase.calls.filter(
      (c) => c.table === 'property_assets' && c.method === 'eq' && c.args[0] === 'org_id',
    )
    expect(orgFilters.length).toBeGreaterThan(0)
    expect(orgFilters[0].args[1]).toBe(ORG)
  })

  it('chunks a large id set, and every chunk stays under the row cap', async () => {
    // 450 ids across a chunk size of 200 → 3 requests. Each `.in()` list also
    // lands in the query string, so the chunk bound is about URL length as much
    // as rows; what must hold is that nothing is dropped and nothing truncates.
    const ids = Array.from({ length: 450 }, (_, i) => `a${i}`)
    const supabase = makeSupabase({
      org_milestones: [milestoneFor(ids)],
      properties:     [{ id: 'prop_1', name: 'Lakehouse' }],
      property_assets: [],
    })

    await renderPage(supabase)

    const inCalls = supabase.calls.filter(
      (c) => c.table === 'property_assets' && c.method === 'in' && c.args[0] === 'id',
    )
    expect(inCalls).toHaveLength(3)
    expect(inCalls.map((c) => (c.args[1] as string[]).length)).toEqual([200, 200, 50])

    // Complete coverage, no overlap — a slice off-by-one would silently drop a
    // row's status back to the "Projected" default.
    const all = requestedAssetIds(supabase)
    expect(all).toEqual(ids)
    expect(new Set(all).size).toBe(450)
  })

  it('does not fetch statuses for a property the filter excluded', async () => {
    // With ?property= set, only that property's items render. Fetching the rest
    // would reintroduce the portfolio-sized read this change removed.
    const year = new Date().getFullYear()
    const supabase = makeSupabase({
      org_milestones: [{
        value: {
          projections: {
            [year]: {
              total_low: 0, total_high: 0,
              items: [item('keep_1', 'prop_1'), item('drop_1', 'prop_2')],
            },
          },
        },
        achieved_at: new Date().toISOString(),
      }],
      properties:      [{ id: 'prop_1', name: 'Lakehouse' }, { id: 'prop_2', name: 'Cabin' }],
      property_assets: [],
    })

    await renderPage(supabase, { property: 'prop_1' })

    expect(requestedAssetIds(supabase)).toEqual(['keep_1'])
  })

  it('issues no status query at all when there is nothing to render', async () => {
    // An org with no projection yet is the common first-run case. `.in('id', [])`
    // is a pointless round trip on a page that is already showing an empty state.
    const supabase = makeSupabase({
      org_milestones:  [],
      properties:      [{ id: 'prop_1', name: 'Lakehouse' }],
      property_assets: [],
    })

    await renderPage(supabase)

    const assetCalls = supabase.calls.filter((c) => c.table === 'property_assets')
    expect(assetCalls).toEqual([])
  })

  it('de-duplicates an asset projected in more than one year', async () => {
    const year = new Date().getFullYear()
    const supabase = makeSupabase({
      org_milestones: [{
        value: {
          projections: {
            [year]:     { total_low: 0, total_high: 0, items: [item('a1')] },
            [year + 3]: { total_low: 0, total_high: 0, items: [item('a1')] },
          },
        },
        achieved_at: new Date().toISOString(),
      }],
      properties:      [{ id: 'prop_1', name: 'Lakehouse' }],
      property_assets: [],
    })

    await renderPage(supabase)

    expect(requestedAssetIds(supabase)).toEqual(['a1'])
  })
})
