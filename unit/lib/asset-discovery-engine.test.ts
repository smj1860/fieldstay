import { describe, it, expect, vi } from 'vitest'
import { getMissingAssetDiscoveryTypes, buildAssetDiscoveryItems } from '@/lib/asset-discovery/engine'
import { REQUIRED_ASSET_TYPES, ASSET_DISCOVERY_SECTION } from '@/lib/asset-discovery/config'
import type { AssetType } from '@/types/database'

type Row = { asset_type: AssetType; make: string | null; model: string | null; photo_url: string | null; is_na: boolean }

function makeSupabase(rows: Row[]) {
  const calls: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq', 'in']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve)

  const from = vi.fn(() => chain)
  return { from, calls }
}

describe('getMissingAssetDiscoveryTypes', () => {
  it('scopes the query to the given property, active assets only, and the required asset types', async () => {
    const supabase = makeSupabase([])

    await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')

    expect(supabase.calls.some((c) => c.method === 'eq' && c.args[0] === 'property_id' && c.args[1] === 'prop_1')).toBe(true)
    expect(supabase.calls.some((c) => c.method === 'eq' && c.args[0] === 'is_active' && c.args[1] === true)).toBe(true)
    expect(supabase.calls.some((c) => c.method === 'in' && c.args[0] === 'asset_type' && c.args[1] === REQUIRED_ASSET_TYPES)).toBe(true)
  })

  it('returns every required type when no property_assets rows exist yet', async () => {
    const supabase = makeSupabase([])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).toEqual(REQUIRED_ASSET_TYPES)
  })

  it('excludes a type verified via a non-null make', async () => {
    const supabase = makeSupabase([
      { asset_type: 'hvac', make: 'Carrier', model: null, photo_url: null, is_na: false },
    ])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).not.toContain('hvac')
  })

  it('excludes a type verified via a non-null model', async () => {
    const supabase = makeSupabase([
      { asset_type: 'water_heater', make: null, model: 'ProLine XE', photo_url: null, is_na: false },
    ])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).not.toContain('water_heater')
  })

  it('excludes a type verified via a non-null photo_url', async () => {
    const supabase = makeSupabase([
      { asset_type: 'refrigerator', make: null, model: null, photo_url: 'https://x/photo.jpg', is_na: false },
    ])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).not.toContain('refrigerator')
  })

  it('excludes a type verified via is_na true', async () => {
    const supabase = makeSupabase([
      { asset_type: 'generator', make: null, model: null, photo_url: null, is_na: true },
    ])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).not.toContain('generator')
  })

  it('keeps a type as missing when its row has no make/model/photo_url and is_na is false', async () => {
    const supabase = makeSupabase([
      { asset_type: 'dishwasher', make: null, model: null, photo_url: null, is_na: false },
    ])
    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).toContain('dishwasher')
  })

  it('treats a null `existing` result (query error swallowed by Supabase) as an empty verified set', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
    const supabase = { from: vi.fn(() => chain) }

    const missing = await getMissingAssetDiscoveryTypes(supabase as never, 'prop_1')
    expect(missing).toEqual(REQUIRED_ASSET_TYPES)
  })
})

describe('buildAssetDiscoveryItems', () => {
  it('builds one mandatory, non-deletable checklist item per missing asset type', () => {
    const items = buildAssetDiscoveryItems('instance_1', 'turnover_1', ['hvac', 'water_heater'], 0)

    expect(items).toEqual([
      {
        instance_id: 'instance_1', turnover_id: 'turnover_1',
        section_name: ASSET_DISCOVERY_SECTION,
        task: 'Capture asset details: HVAC',
        requires_photo: false, photo_reason: null, notes: null,
        sort_order: 0, is_completed: false, is_mandatory: true, non_deletable: true,
        asset_discovery_type: 'hvac',
      },
      {
        instance_id: 'instance_1', turnover_id: 'turnover_1',
        section_name: ASSET_DISCOVERY_SECTION,
        task: 'Capture asset details: Water Heater',
        requires_photo: false, photo_reason: null, notes: null,
        sort_order: 1, is_completed: false, is_mandatory: true, non_deletable: true,
        asset_discovery_type: 'water_heater',
      },
    ])
  })

  it('offsets sort_order by the provided startSortOrder', () => {
    const items = buildAssetDiscoveryItems('instance_1', 'turnover_1', ['hvac', 'water_heater', 'refrigerator'], 10)
    expect(items.map((i) => i.sort_order)).toEqual([10, 11, 12])
  })

  it('returns an empty array when there are no missing asset types', () => {
    expect(buildAssetDiscoveryItems('instance_1', 'turnover_1', [], 0)).toEqual([])
  })
})
