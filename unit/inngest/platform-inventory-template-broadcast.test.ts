import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { broadcastPlatformInventoryTemplate } from '@/lib/inngest/functions/platform-inventory-template-broadcast'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based mock, same shape as checklist-broadcast.test.ts — this
// function re-queries the same tables multiple times per org (existing
// template lookup, existing items lookup, insert), so a fixed per-table
// canned response isn't enough.
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
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }

describe('broadcastPlatformInventoryTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when the platform template no longer exists', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: null, requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })

    expect(result).toEqual({ synced_orgs: 0, reason: 'template_not_found' })
  })

  it('is a no-op when the template has no items', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: { id: 'tmpl_1', name: 'Standard', description: null }, error: null }],
      platform_inventory_template_items: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: null, requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })

    expect(result).toEqual({ synced_orgs: 0, reason: 'no_items' })
  })

  it('creates a linked template and adds every master item for an org with no existing copy', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: { id: 'tmpl_1', name: 'Standard', description: 'Master list' }, error: null }],
      platform_inventory_template_items: [
        { data: [{ catalog_item_id: 'cat_1', par_level: 2, preferred_brand: 'Bounty', sort_order: 0 }], error: null },
      ],
      inventory_catalog: [
        { data: [{ id: 'cat_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll' }], error: null },
      ],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [
        { data: null, error: null },                          // existing-template lookup — none
        { data: { id: 'org_tmpl_1' }, error: null },           // insert new org template
      ],
      inventory_template_items: [
        { data: [], error: null },                             // existing items — none
        { data: null, error: null },                            // insert
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: null, requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })

    expect(result).toEqual({ synced_orgs: 1, total_orgs: 1 })

    const orgTemplateInsert = supabase.calls.find((c) => c.table === 'inventory_templates' && c.method === 'insert')
    expect(orgTemplateInsert?.args[0]).toEqual(
      expect.objectContaining({ org_id: 'org_1', name: 'Standard', description: 'Master list', source_platform_template_id: 'tmpl_1' })
    )

    const itemInsert = supabase.calls.find((c) => c.table === 'inventory_template_items' && c.method === 'insert')
    expect(itemInsert?.args[0]).toEqual([
      expect.objectContaining({
        template_id:     'org_tmpl_1',
        catalog_item_id: 'cat_1',
        name:            'Paper Towels',
        category:        'paper_goods',
        unit:            'roll',
        par_level:       2,
        preferred_brand: 'Bounty',
        sort_order:      0,
      }),
    ])

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({ orgId: 'org_1', action: 'platform_admin.inventory_template.broadcast_synced', metadata: { platform_template_id: 'tmpl_1', items_added: 1 } }),
    ])
  })

  it('only adds items the org does not already have, and never touches existing rows', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: { id: 'tmpl_1', name: 'Standard', description: null }, error: null }],
      platform_inventory_template_items: [
        {
          data: [
            { catalog_item_id: 'cat_1', par_level: 2, preferred_brand: null, sort_order: 0 },
            { catalog_item_id: 'cat_2', par_level: 4, preferred_brand: null, sort_order: 1 },
          ],
          error: null,
        },
      ],
      inventory_catalog: [
        {
          data: [
            { id: 'cat_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll' },
            { id: 'cat_2', name: 'Trash Bags', category: 'cleaning', default_unit: 'box' },
          ],
          error: null,
        },
      ],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [{ data: { id: 'org_tmpl_1' }, error: null }],   // already linked
      inventory_template_items: [
        { data: [{ catalog_item_id: 'cat_1' }], error: null },              // org already has cat_1
        { data: null, error: null },                                        // insert (cat_2 only)
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: ['org_1'], requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })

    expect(result).toEqual({ synced_orgs: 1, total_orgs: 1 })

    // No second insert/update touching cat_1 — only cat_2 gets inserted.
    const itemInsert = supabase.calls.find((c) => c.table === 'inventory_template_items' && c.method === 'insert')
    expect(itemInsert?.args[0]).toEqual([
      expect.objectContaining({ catalog_item_id: 'cat_2', par_level: 4 }),
    ])
    expect((itemInsert?.args[0] as unknown[]).length).toBe(1)

    // No fresh inventory_templates insert — the org already had a linked row.
    const orgTemplateInsert = supabase.calls.find((c) => c.table === 'inventory_templates' && c.method === 'insert')
    expect(orgTemplateInsert).toBeUndefined()
  })

  it('is a no-op for an org that already has every master item', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: { id: 'tmpl_1', name: 'Standard', description: null }, error: null }],
      platform_inventory_template_items: [
        { data: [{ catalog_item_id: 'cat_1', par_level: 2, preferred_brand: null, sort_order: 0 }], error: null },
      ],
      inventory_catalog: [
        { data: [{ id: 'cat_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll' }], error: null },
      ],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [{ data: { id: 'org_tmpl_1' }, error: null }],
      inventory_template_items: [{ data: [{ catalog_item_id: 'cat_1' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: ['org_1'], requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })

    expect(result).toEqual({ synced_orgs: 0, total_orgs: 1 })
    expect(supabase.calls.some((c) => c.table === 'inventory_template_items' && c.method === 'insert')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Failure handling. Every case below used to return a success-shaped result
// while quietly doing less than it claimed — the broadcast is deliberately
// re-runnable (that is how new master items reach existing orgs), so each of
// these is reachable on an ordinary run, not just an exotic one.
// ============================================================================
describe('broadcastPlatformInventoryTemplate — failures are not silent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const templateRow = { data: { id: 'tmpl_1', name: 'Standard', description: null }, error: null }
  const masterItems = {
    data: [{ catalog_item_id: 'cat_1', par_level: 2, preferred_brand: null, sort_order: 0 }],
    error: null,
  }
  const catalogRows = {
    data: [{ id: 'cat_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll' }],
    error: null,
  }

  function run(supabase: unknown, targetOrgIds: string[] | null = ['org_1']) {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    return invokeHandler(broadcastPlatformInventoryTemplate, {
      event:  { data: { platform_template_id: 'tmpl_1', target_org_ids: targetOrgIds, requested_by: 'admin_1' } },
      step:   runAllStep(),
      logger: noopLogger,
    })
  }

  // The template read discarded its error, so a read failure was reported as
  // `template_not_found` and cancelled the entire broadcast as a "success".
  it('throws rather than reporting template_not_found when the template read errors', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [{ data: null, error: { message: 'connection reset' } }],
    })
    await expect(run(supabase)).rejects.toThrow()
  })

  // THE dedup read: `toAdd` is the master list minus whatever it returns, so a
  // discarded error produced an empty Set — "this org has nothing yet" — and
  // re-inserted the entire master list. There was no unique index behind it
  // either until 20260808060000, so nothing could refuse the duplicates.
  it('throws instead of re-inserting the whole master list when the existing-items (dedup) read errors', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [templateRow],
      platform_inventory_template_items: [masterItems],
      inventory_catalog: [catalogRows],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [{ data: { id: 'org_tmpl_1' }, error: null }],
      inventory_template_items: [{ data: null, error: { message: 'statement timeout', code: '57014' } }],
    })

    await expect(run(supabase)).rejects.toThrow()
    // Critically: it must not have fallen through to an insert with an empty
    // dedup set, which is what produced duplicates.
    expect(supabase.calls.some((c) => c.table === 'inventory_template_items' && c.method === 'insert')).toBe(false)
  })

  // A caught-and-returned error inside step.run marks the step COMPLETE and
  // memoizes the 0, so Inngest never retries it — `retries: 3` was inert for
  // both write paths — and the org silently drops out of a broadcast whose
  // return value still reports a healthy synced count.
  it('throws (so the step retries) when the item insert fails, instead of counting the org as synced-with-0', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [templateRow],
      platform_inventory_template_items: [masterItems],
      inventory_catalog: [catalogRows],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [{ data: { id: 'org_tmpl_1' }, error: null }],
      inventory_template_items: [
        { data: [], error: null },                                        // dedup read: org has nothing
        { data: null, error: { message: 'deadlock detected', code: '40P01' } },  // insert
      ],
    })

    await expect(run(supabase)).rejects.toThrow('deadlock detected')
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('throws when creating the org-side template fails', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [templateRow],
      platform_inventory_template_items: [masterItems],
      inventory_catalog: [catalogRows],
      organizations: [{ data: [{ id: 'org_1' }], error: null }],
      inventory_templates: [
        { data: null, error: null },                                       // no existing linked template
        { data: null, error: { message: 'duplicate key value', code: '23505' } },  // create
      ],
    })

    await expect(run(supabase)).rejects.toThrow('duplicate key value')
  })

  // The untargeted branch hand-rolled its pagination with `const { data }` and
  // `if (!data?.length) break`, so a read error on page 2 was indistinguishable
  // from "no more orgs": the broadcast covered a PREFIX of the platform and
  // still reported total_orgs as if it were complete. fetchAllRows throws.
  it('throws rather than broadcasting to a prefix of the platform when an org page errors', async () => {
    const supabase = makeSupabase({
      platform_inventory_templates: [templateRow],
      platform_inventory_template_items: [masterItems],
      inventory_catalog: [catalogRows],
      organizations: [{ data: null, error: { message: 'connection reset' } }],
    })

    await expect(run(supabase, null)).rejects.toThrow()
  })
})
