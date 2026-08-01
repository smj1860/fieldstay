import { describe, it, expect, vi, beforeEach } from 'vitest'

// createOrGetTemplate and applyTemplateToProperty (singular) were removed
// from this file by the Templates Hub refactor on main (superseded by
// createInventoryTemplate / applyTemplateToProperties in
// app/(dashboard)/templates/inventory/actions.ts) — no longer tested here.

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import {
  updateParLevel,
  addInventoryItems,
  submitInventoryCount,
  addTemplateItem,
  updateTemplateItemBrand,
  removeTemplateItem,
  applyTemplateToProperties,
  approveInventoryCount,
  rejectInventoryCount,
  generateAggregatedPurchaseList,
  updatePurchaseOrderStatus,
  triggerShoppingCart,
} from '@/app/(dashboard)/inventory/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    // `order`/`range` are needed by the fetchAllRows() pagination the
    // truncation fixes introduced (a single short page ends the drain).
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'is', 'limit', 'order', 'range', 'maybeSingle']) {
      chain[m] = vi.fn(() => chain)
    }
    // maybeSingle overridden below to actually resolve
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('inventory/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('updateParLevel', () => {
    it('updates the par level scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await updateParLevel('item_1', 5)

      expect(result).toEqual({ success: true })
      expect(supabase.from).toHaveBeenCalledWith('inventory_items')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateParLevel('item_1', 5)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addInventoryItems', () => {
    function itemsFd() {
      return fd({
        property_id: 'prop_1',
        item_count:  '1',
        'item_0_name':      'Paper towels',
        'item_0_category':  'paper_goods',
        'item_0_unit':      'roll',
        'item_0_par_level': '4',
      })
    }

    it('adds items when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        inventory_items: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addInventoryItems(null, itemsFd())

      expect(result).toEqual({ success: true })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addInventoryItems(null, itemsFd())

      expect(result).toEqual({ error: 'Property not found' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addInventoryItems(null, itemsFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('submitInventoryCount', () => {
    it('records a count and fires the count-submitted event, scoped to the caller org', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        inventory_counts:      [{ data: { id: 'count_1' } }],
        inventory_count_items: [{ error: null }],
        inventory_items:       [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const form = fd({ property_id: 'prop_1' })
      form.append('item_item-a', '3')

      const result = await submitInventoryCount(null, form)

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'inventory/count-submitted',
        data: { count_id: 'count_1', property_id: 'prop_1', org_id: 'org_1' },
      })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await submitInventoryCount(null, fd({ property_id: 'other-orgs-property' }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await submitInventoryCount(null, fd({ property_id: 'prop_1' }))

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addTemplateItem', () => {
    it('inserts a template item once the template is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        inventory_templates:       [{ data: { id: 'tmpl_1' } }],
        inventory_template_items: [{
          data: { id: 'ti_1', name: 'Towels', category: 'bath', unit: 'each', par_level: 6, notes: null, preferred_brand: null },
        }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addTemplateItem('tmpl_1', { name: 'Towels', category: 'bath', unit: 'each', par_level: 6 })

      expect(result.item?.id).toBe('ti_1')
    })

    it('rejects a template id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ inventory_templates: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addTemplateItem('other-orgs-template', { name: 'Towels', category: 'bath', unit: 'each', par_level: 6 })

      expect(result).toEqual({ error: 'Template not found.' })
      expect(supabase.from).not.toHaveBeenCalledWith('inventory_template_items')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addTemplateItem('tmpl_1', { name: 'Towels', category: 'bath', unit: 'each', par_level: 6 })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateTemplateItemBrand', () => {
    it('updates the brand once the item is verified to belong to the caller org via the template join', async () => {
      const supabase = makeSupabase({
        inventory_template_items: [{ data: { id: 'ti_1' } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await updateTemplateItemBrand('ti_1', 'Bounty')

      expect(result).toEqual({})
    })

    it('rejects an item id whose template does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ inventory_template_items: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await updateTemplateItemBrand('other-orgs-item', 'Bounty')

      expect(result).toEqual({ error: 'Item not found' })
    })
  })

  describe('removeTemplateItem', () => {
    it('removes the item once verified to belong to the caller org via the template join', async () => {
      const supabase = makeSupabase({
        inventory_template_items: [{ data: { id: 'ti_1' } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await removeTemplateItem('ti_1')

      expect(result).toEqual({})
    })

    it('rejects an item id whose template does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ inventory_template_items: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await removeTemplateItem('other-orgs-item')

      expect(result).toEqual({ error: 'Item not found' })
    })
  })

  describe('applyTemplateToProperties', () => {
    it('applies template items only to properties verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        inventory_templates:       [{ data: { id: 'tmpl_1' } }],
        inventory_template_items: [{ data: [{ id: 'ti_1', name: 'Towels', category: 'bath', unit: 'each', par_level: 6, catalog_item_id: null }] }],
        properties:                [{ data: [{ id: 'prop_1' }] }], // only prop_1 verified — prop_2 (other org) dropped
        inventory_items:           [{ data: [] }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await applyTemplateToProperties('tmpl_1', ['prop_1', 'other-orgs-property'])

      expect(result).toEqual({ applied: 1 })
    })

    // ── Regression: max_rows = 1000 silently truncated the dedupe set ────
    // The existing-items read IS the duplicate guard, and it was a single
    // unbounded select. At CLAUDE.md's own target scale (50 properties × a
    // 115-item catalog = 5,750 rows) every property past the first ~8 had its
    // existing items invisible and got a full duplicate set inserted, with a
    // 200 and no error anywhere. Pre-fix this asserts applied: 0 but gets 1.
    it('sees an existing item that lands on the SECOND page of the dedupe read', async () => {
      const filler = Array.from({ length: 1000 }, (_, i) => ({
        property_id: 'prop_other', catalog_item_id: null, name: `filler ${i}`,
      }))
      const supabase = makeSupabase({
        inventory_templates:      [{ data: { id: 'tmpl_1' } }],
        inventory_template_items: [{ data: [{ id: 'ti_1', name: 'Towels', category: 'bath', unit: 'each', par_level: 6, catalog_item_id: null }] }],
        properties:               [{ data: [{ id: 'prop_1' }] }],
        inventory_items: [
          { data: filler },                                                                    // page 1 — full page
          { data: [{ property_id: 'prop_1', catalog_item_id: null, name: 'Towels' }] },        // page 2 — the row that must dedupe
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await applyTemplateToProperties('tmpl_1', ['prop_1'])

      expect(result).toEqual({ applied: 0 })
    })

    it('rejects a template id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ inventory_templates: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await applyTemplateToProperties('other-orgs-template', ['prop_1'])

      expect(result).toEqual({ error: 'Template not found.', applied: 0 })
      expect(supabase.from).not.toHaveBeenCalledWith('inventory_template_items')
    })

    it('returns no matching properties when none verify against the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        inventory_templates:       [{ data: { id: 'tmpl_1' } }],
        inventory_template_items: [{ data: [{ id: 'ti_1', name: 'Towels', category: 'bath', unit: 'each', par_level: 6 }] }],
        properties:                [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await applyTemplateToProperties('tmpl_1', ['other-orgs-property'])

      expect(result).toEqual({ error: 'No valid properties selected', applied: 0 })
    })
  })

  describe('approveInventoryCount / rejectInventoryCount', () => {
    it('approves a draft belonging to the caller org and applies counted quantities', async () => {
      const supabase = makeSupabase({
        inventory_count_drafts:      [{ data: { id: 'draft_1' } }, { data: { id: 'draft_1' } }],
        inventory_count_draft_items: [{ data: [{ item_id: 'item_1', counted_qty: 3 }] }],
        inventory_items:             [{ data: [] }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await approveInventoryCount('draft_1')

      expect(result).toEqual({})
    })

    it('rejects a draft id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ inventory_count_drafts: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await approveInventoryCount('other-orgs-draft')

      expect(result).toEqual({ error: 'Draft not found' })
    })

    it('rejectInventoryCount does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await rejectInventoryCount('draft_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('generateAggregatedPurchaseList', () => {
    it('aggregates below-par items scoped to the caller org', async () => {
      const supabase = makeSupabase({
        inventory_items: [{
          data: [
            { name: 'Towels', unit: 'each', current_quantity: 1, par_level: 6, first_count_recorded_at: '2026-01-01', property_id: 'prop_1', property: { name: 'Lakehouse' } },
          ],
        }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await generateAggregatedPurchaseList()

      expect(result.items).toEqual([
        { name: 'Towels', unit: 'each', totalNeeded: 5, properties: [{ name: 'Lakehouse', needed: 5 }] },
      ])
    })

    // ── Regression: the `.limit(2000)` "well above any real org's inventory"
    // comment was wrong about CLAUDE.md's own target user (50 properties ×
    // 115 catalog items = 5,750 rows). Everything past row 2,000 was silently
    // missing from the purchase list — the PM under-orders and stock runs out.
    // Pre-fix, the second page is never fetched and this returns [].
    it('includes below-par items past the first page of a paginated read', async () => {
      const filler = Array.from({ length: 1000 }, (_, i) => ({
        name: `Stocked ${i}`, unit: 'each', current_quantity: 10, par_level: 1,
        first_count_recorded_at: '2026-01-01', property_id: 'prop_1', property: { name: 'Lakehouse' },
      }))
      const supabase = makeSupabase({
        inventory_items: [
          { data: filler },
          { data: [{ name: 'Towels', unit: 'each', current_quantity: 1, par_level: 6, first_count_recorded_at: '2026-01-01', property_id: 'prop_2', property: { name: 'Cabin' } }] },
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await generateAggregatedPurchaseList()

      expect(result.items).toEqual([
        { name: 'Towels', unit: 'each', totalNeeded: 5, properties: [{ name: 'Cabin', needed: 5 }] },
      ])
    })

    it('returns an empty list and never throws when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await generateAggregatedPurchaseList()

      expect(result).toEqual({ items: [], error: 'Operation failed. Please try again.' })
    })
  })

  describe('updatePurchaseOrderStatus', () => {
    it('updates status and dispatches the approved event scoped to the caller org', async () => {
      const supabase = makeSupabase({
        purchase_orders: [
          { data: { id: 'po_1', property_id: 'prop_1', total_estimated_cost: 100, status: 'sent' } },
          { data: { id: 'po_1' } },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await updatePurchaseOrderStatus('po_1', 'ordered')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'purchase_order.status_changed',
        targetId: 'po_1',
      }))
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'purchase-order/approved',
        data: {
          purchase_order_id:    'po_1',
          property_id:          'prop_1',
          org_id:               'org_1',
          total_estimated_cost: 100,
        },
      })
    })

    it('rejects a purchase order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ purchase_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await updatePurchaseOrderStatus('other-orgs-po', 'ordered')

      expect(result).toEqual({ error: 'Purchase order not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await updatePurchaseOrderStatus('po_1', 'ordered')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('triggerShoppingCart', () => {
    it('sends the cart_requested event for the caller org', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, membership,
      } as never)

      const result = await triggerShoppingCart(['prop_1'], 'DELIVERY')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        // Event `id` added in this session. buildShoppingCart's
        // concurrency { limit: 1, key: 'event.data.org_id' } plus its
        // content-fingerprint claim already made duplicate Kroger cart
        // additions impossible, but neither stopped a second RUN existing:
        // a double-clicked "Build Cart" no-opped on the cart and then still
        // emailed the PM a second "your cart is ready". Inngest dedups on
        // this id, collapsing the duplicate at the source.
        // Trailing segment is a minute bucket — matched loosely so the
        // assertion can't fail purely by straddling a minute boundary. The
        // bucket's actual collapsing behaviour is asserted in the next test.
        id:   expect.stringMatching(/^cart-requested:org_1:user_1:DELIVERY:prop_1:\d+$/),
        name: 'inventory/cart_requested',
        data: { org_id: 'org_1', requested_by: 'user_1', property_ids: ['prop_1'], modality: 'DELIVERY' },
      })
    })

    it('gives two rapid double-clicks the SAME idempotency key, so only one cart-ready email is sent', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, membership,
      } as never)

      // Frozen so the two clicks can't land either side of a minute boundary
      // and make this assertion time-dependent.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-31T12:00:30Z'))
      try {
        await triggerShoppingCart(['prop_b', 'prop_a'], 'PICKUP')
        await triggerShoppingCart(['prop_a', 'prop_b'], 'PICKUP')
      } finally {
        vi.useRealTimers()
      }

      const ids = vi.mocked(inngest.send).mock.calls.map((c) => (c[0] as { id: string }).id)
      expect(ids).toHaveLength(2)
      // Property order is normalised, so the same selection reached from a
      // differently-ordered array is still one logical request.
      expect(ids[0]).toBe(ids[1])
    })

    it('keys the request by org, user, modality and property scope so unrelated builds are never collapsed', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, membership,
      } as never)

      await triggerShoppingCart(['prop_1'], 'PICKUP')
      await triggerShoppingCart(['prop_1'], 'DELIVERY')
      await triggerShoppingCart(undefined, 'PICKUP')

      const ids = vi.mocked(inngest.send).mock.calls.map((c) => (c[0] as { id: string }).id)
      expect(new Set(ids).size).toBe(3)
      // An all-properties build is a distinct scope, not an empty one.
      expect(ids[2]).toContain(':PICKUP:all:')
    })

    // The property scope is canonicalised with an explicit code-unit
    // comparator, not String.localeCompare (what Sonar's "provide a compare
    // function" rule suggests). Locale-aware collation is locale- and
    // ICU-version-dependent, so two environments could derive different
    // idempotency keys for the same request — exactly what this key exists to
    // prevent. en-US collation would order ['B','a'] as 'a,B'; code-unit
    // ordering gives 'B,a', so this assertion pins the deterministic choice.
    it('canonicalises the property scope deterministically, independent of locale collation', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, membership,
      } as never)

      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-31T12:00:30Z'))
      try {
        await triggerShoppingCart(['a', 'B'], 'PICKUP')
        await triggerShoppingCart(['B', 'a'], 'PICKUP')
      } finally {
        vi.useRealTimers()
      }

      const ids = vi.mocked(inngest.send).mock.calls.map((c) => (c[0] as { id: string }).id)
      expect(ids[0]).toBe(ids[1])
      expect(ids[0]).toContain(':PICKUP:B,a:')
    })

    it('throws when the caller is not an authenticated org member', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(triggerShoppingCart(['prop_1'])).rejects.toThrow('REDIRECT:/login')
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('reports failure without throwing when the Inngest send itself fails', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, membership,
      } as never)
      vi.mocked(inngest.send).mockRejectedValueOnce(new Error('Inngest unavailable'))

      const result = await triggerShoppingCart(['prop_1'])

      expect(result).toEqual({ success: false, error: 'Failed to start cart build. Try again.' })
      expect(reportError).toHaveBeenCalled()
    })
  })
})
