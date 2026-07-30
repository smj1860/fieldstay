import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgRole: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { upsertParLevelItems, createInventoryTemplateFromCSV } from '@/app/(dashboard)/templates/inventory/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'in']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('templates/inventory/actions — upsertParLevelItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const newItem = { name: 'Towels', category: 'bath' as const, unit: 'each', par_level: 6, preferred_brand: null }

  // Regression test for a live IDOR bug fixed in this session: this function
  // verified existing-item ownership (via a join on inventory_items.id) but
  // never verified the propertyId parameter itself belonged to the caller's
  // org before inserting NEW items — RLS on inventory_items_insert only
  // checks the row's own org_id, not that property_id belongs to it (see
  // 20260722000000_atomic_template_item_replace.sql, which documents this
  // exact gap for the sibling cloneInventoryFromProperty function but never
  // got applied here). Without the fix, a caller could insert inventory
  // items for a property belonging to a different org.
  it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
    const supabase = makeSupabase({ properties: [{ data: null }] })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    const result = await upsertParLevelItems('other-orgs-property', [newItem])

    expect(result).toEqual({ error: 'Property not found' })
    expect(supabase.from).not.toHaveBeenCalledWith('inventory_items')
  })

  it('inserts new items once the property is verified to belong to the caller org', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [{ id: 'item_1', property_id: 'prop_1', catalog_item_id: null, source_template_id: null, name: 'Towels', category: 'bath', unit: 'each', par_level: 6, preferred_brand: null }] }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    const result = await upsertParLevelItems('prop_1', [newItem])

    expect(result.items).toHaveLength(1)
    expect(result.error).toBeUndefined()
  })

  it('rejects an existing item id that does not belong to the caller org (IDOR check)', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [] }], // verified-rows lookup finds nothing owned
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    const result = await upsertParLevelItems('prop_1', [{ ...newItem, id: 'other-orgs-item' }])

    expect(result).toEqual({ items: [] })
    // The ownership-check select happens, but the item is never passed to upsert.
    expect(supabase.from).toHaveBeenCalledTimes(2) // properties, then inventory_items (select only)
  })

  it('returns a generic error and never touches the DB when the caller lacks the required role', async () => {
    const supabase = makeSupabase({})
    vi.mocked(requireOrgRole).mockRejectedValue(new Error('You do not have permission to perform this action.'))

    const result = await upsertParLevelItems('prop_1', [newItem])

    expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('writes normalized par config for a new smart item', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [{ id: 'item_1', property_id: 'prop_1', catalog_item_id: null, source_template_id: null, name: 'Towels', category: 'bath', unit: 'each', par_level: 6, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2, auto_adjust: true, par_resolved_at: null, preferred_brand: null }] }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    await upsertParLevelItems('prop_1', [
      { ...newItem, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2 },
    ])

    const insertCall = supabase.from.mock.results.find((r, i) => supabase.from.mock.calls[i]?.[0] === 'inventory_items')!.value
    expect(insertCall.insert).toHaveBeenCalledWith([
      expect.objectContaining({ par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2 }),
    ])
  })

  it('degrades a smart item with a null group to static before writing', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [{ id: 'item_1', property_id: 'prop_1', catalog_item_id: null, source_template_id: null, name: 'Towels', category: 'bath', unit: 'each', par_level: 6, par_mode: 'static', smart_group: null, base_qty: 1, auto_adjust: true, par_resolved_at: null, preferred_brand: null }] }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    await upsertParLevelItems('prop_1', [
      { ...newItem, par_mode: 'smart', smart_group: null, base_qty: 2 },
    ])

    const insertCall = supabase.from.mock.results.find((r, i) => supabase.from.mock.calls[i]?.[0] === 'inventory_items')!.value
    expect(insertCall.insert).toHaveBeenCalledWith([
      expect.objectContaining({ par_mode: 'static', smart_group: null }),
    ])
  })

  it('sends a par-recompute event when the save touches a smart item', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [{ id: 'item_1', property_id: 'prop_1', catalog_item_id: null, source_template_id: null, name: 'Towels', category: 'bath', unit: 'each', par_level: 6, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2, auto_adjust: true, par_resolved_at: null, preferred_brand: null }] }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    await upsertParLevelItems('prop_1', [{ ...newItem, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2 }])

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'inventory/par-recompute-requested',
      data: { org_id: 'org_1', property_id: 'prop_1' },
    })
  })

  it('does not send a par-recompute event on a pin-to-static save', async () => {
    const supabase = makeSupabase({
      properties:      [{ data: { id: 'prop_1' } }],
      inventory_items: [{ data: [{ id: 'item_1', property_id: 'prop_1', catalog_item_id: null, source_template_id: null, name: 'Towels', category: 'bath', unit: 'each', par_level: 6, par_mode: 'static', smart_group: null, base_qty: 1, auto_adjust: true, par_resolved_at: null, preferred_brand: null }] }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    await upsertParLevelItems('prop_1', [newItem])

    expect(inngest.send).not.toHaveBeenCalled()
  })
})

describe('templates/inventory/actions — createInventoryTemplateFromCSV', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lands CSV-imported rows explicitly static, with no catalog row to inherit from', async () => {
    const supabase = makeSupabase({
      org_inventory_catalog: [{ data: [] }],
      inventory_templates:   [{ data: { id: 'tmpl_1' } }],
      inventory_template_items: [{ data: null }],
    })
    vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership, user: { id: 'user_1' } } as never)

    await createInventoryTemplateFromCSV('CSV Template', [
      { name: 'Dish Soap', category: 'kitchen', unit: 'bottle', par_level: 2, preferred_brand: null },
    ])

    const insertCall = supabase.from.mock.results.find((r, i) => supabase.from.mock.calls[i]?.[0] === 'inventory_template_items')!.value
    expect(insertCall.insert).toHaveBeenCalledWith([
      expect.objectContaining({ par_mode: 'static', smart_group: null, base_qty: 1 }),
    ])
  })
})
