import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inventory/standard-template', () => ({ getStandardInventoryTemplateId: vi.fn() }))

import { applyStandardInventoryToProperty } from '@/lib/inventory/apply-standard-to-property'
import { getStandardInventoryTemplateId } from '@/lib/inventory/standard-template'

// ============================================================================
// Leg 3: a new property is stocked from the standard template at creation.
//
// Two behaviours here are decisions rather than mechanics, and both are the
// kind that regress silently:
//
//   1. SOURCE PREFERENCE. The org's own copy of the standard wins over the
//      platform template, because a PM who adjusted their par levels must get
//      THEIR numbers. But the org copy is absent for the seconds between signup
//      and leg 2's Inngest function landing, AND for every org that predates
//      leg 2 — so the platform fallback is what makes the feature work at all
//      for existing customers. Losing either half looks like nothing.
//
//   2. DEDUP ON BOTH KEYS. catalog_item_id alone misses an item a PM typed by
//      hand; name alone misses one whose catalog row was renamed. A duplicate
//      row doubles every restock count for that item, quietly.
// ============================================================================

const PROP = 'prop-1'
const ORG  = 'org-1'

interface Resp { data: unknown; error: unknown }

/** Per-table canned responses; the chain is permissive so call order is free. */
function makeSupabase(byTable: Record<string, Resp>) {
  const inserts: unknown[][] = []
  const from = vi.fn((table: string) => {
    const resp = byTable[table] ?? { data: [], error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve(resp))
    chain.insert = vi.fn((rows: unknown[]) => { inserts.push(rows); return Promise.resolve({ error: null }) })
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(resp).then(res)
    return chain
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, inserts }
}

const ORG_ITEM = {
  catalog_item_id: 'cat-1', name: 'Bath Towels', category: 'bath', unit: 'each',
  par_level: 99, par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2, preferred_brand: null,
}
const PLATFORM_ROW = {
  catalog_item_id: 'cat-1', par_level: 14, par_mode: 'smart', smart_group: 'guest_consumable',
  base_qty: 2, preferred_brand: null,
  inventory_catalog: [{ name: 'Bath Towels', category: 'bath', default_unit: 'each' }],
}

describe('applyStandardInventoryToProperty', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing when no standard template is designated', async () => {
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue(null)
    const { client, inserts } = makeSupabase({})
    await expect(applyStandardInventoryToProperty(PROP, ORG, client))
      .resolves.toEqual({ applied: 0, source: 'none' })
    expect(inserts).toHaveLength(0)
  })

  it("prefers the ORG's copy, so a PM's adjusted par levels win", async () => {
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('plat-1')
    const { client, inserts } = makeSupabase({
      inventory_templates:      { data: { id: 'org-tpl-1' }, error: null },
      inventory_template_items: { data: [ORG_ITEM], error: null },
      inventory_items:          { data: [], error: null },
    })
    const res = await applyStandardInventoryToProperty(PROP, ORG, client)
    expect(res).toEqual({ applied: 1, source: 'org_template' })
    // 99 is the org's edited par, not the platform's 14.
    expect(inserts[0][0]).toMatchObject({ name: 'Bath Towels', par_level: 99, source_template_id: 'org-tpl-1' })
  })

  it('falls back to the PLATFORM template when the org has no copy yet', async () => {
    // The case that covers both the signup race and every org predating leg 2.
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('plat-1')
    const { client, inserts } = makeSupabase({
      inventory_templates:               { data: null, error: null },   // no org copy
      platform_inventory_template_items: { data: [PLATFORM_ROW], error: null },
      inventory_items:                   { data: [], error: null },
    })
    const res = await applyStandardInventoryToProperty(PROP, ORG, client)
    expect(res).toEqual({ applied: 1, source: 'platform_template' })
    expect(inserts[0][0]).toMatchObject({ name: 'Bath Towels', par_level: 14, source_template_id: null })
  })

  it('reads the embed as an ARRAY — PostgREST never returns a bare object', async () => {
    // PLATFORM_ROW.inventory_catalog is an array above on purpose. Reading it
    // as an object yields undefined for name, which is NOT NULL on
    // inventory_items, so the whole insert would fail at the DB.
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('plat-1')
    const { client, inserts } = makeSupabase({
      inventory_templates:               { data: null, error: null },
      platform_inventory_template_items: { data: [PLATFORM_ROW], error: null },
      inventory_items:                   { data: [], error: null },
    })
    await applyStandardInventoryToProperty(PROP, ORG, client)
    expect(inserts[0][0]).toMatchObject({ name: 'Bath Towels', category: 'bath', unit: 'each' })
  })

  it('skips an item the property already has by catalog_item_id', async () => {
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('plat-1')
    const { client, inserts } = makeSupabase({
      inventory_templates:      { data: { id: 'org-tpl-1' }, error: null },
      inventory_template_items: { data: [ORG_ITEM], error: null },
      inventory_items:          { data: [{ catalog_item_id: 'cat-1', name: 'Something Else' }], error: null },
    })
    await expect(applyStandardInventoryToProperty(PROP, ORG, client))
      .resolves.toEqual({ applied: 0, source: 'org_template' })
    expect(inserts).toHaveLength(0)
  })

  it('skips an item the property already has by NAME, case-insensitively', async () => {
    // The hand-typed-item case: no catalog link, so only the name matches.
    vi.mocked(getStandardInventoryTemplateId).mockResolvedValue('plat-1')
    const { client, inserts } = makeSupabase({
      inventory_templates:      { data: { id: 'org-tpl-1' }, error: null },
      inventory_template_items: { data: [ORG_ITEM], error: null },
      inventory_items:          { data: [{ catalog_item_id: null, name: 'bath towels' }], error: null },
    })
    await expect(applyStandardInventoryToProperty(PROP, ORG, client))
      .resolves.toEqual({ applied: 0, source: 'org_template' })
    expect(inserts).toHaveLength(0)
  })
})
