import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
// Pulled in transitively via properties/actions.ts's markStepComplete ->
// lib/checklists/apply-master-template.ts.
vi.mock('server-only', () => ({}))

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('REDIRECT:')) throw err
  },
}))
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
// Pulled in transitively via properties/actions.ts's markStepComplete, used
// by completeInventoryStep — not under test in this file.
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
// applyTemplateToProperty is defined and fully tested in
// unit/inventory/inventory-actions.test.ts — this file just re-exports it,
// so stub the module it's actually implemented in to keep this test file
// isolated from that action's own DB/audit/inngest requirements.
vi.mock('@/app/(dashboard)/inventory/actions', () => ({
  applyTemplateToProperty: vi.fn(),
}))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import {
  upsertInventoryItems,
  deleteInventoryItem,
  bulkDeleteInventoryItems,
  completeInventoryStep,
  cloneInventoryFromProperty,
} from '@/app/(dashboard)/properties/[id]/setup/inventory/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('properties/[id]/setup/inventory/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('upsertInventoryItems', () => {
    const newItem = {
      name: 'Paper towels', category: 'paper_goods', unit: 'roll', par_level: 4,
    }

    it('inserts new items once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        inventory_items: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await upsertInventoryItems('prop_1', [newItem])

      expect(result).toEqual({ success: true })
    })

    it('upserts existing items whose ids are verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        inventory_items: [{ data: [{ id: 'item_1' }] }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await upsertInventoryItems('prop_1', [{ ...newItem, id: 'item_1' }])

      expect(result).toEqual({ success: true })
    })

    it('silently drops an existing-item id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        inventory_items: [{ data: [] }], // verifiedRows query finds nothing owned
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await upsertInventoryItems('prop_1', [{ ...newItem, id: 'other-orgs-item' }])

      expect(result).toEqual({ success: true })
      expect(supabase.calls.some((c) => c.table === 'inventory_items' && c.method === 'upsert')).toBe(false)
    })

    // Regression test — upsertInventoryItems previously wrote a
    // client-supplied propertyId into every inserted/upserted inventory_items
    // row's property_id column without ever verifying it belonged to the
    // caller's org. See CLAUDE.md's IDOR standing-audit item; fixed in this
    // session by adding the same ownership check used throughout this
    // setup-wizard file set.
    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await upsertInventoryItems('other-orgs-property', [newItem])

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('inventory_items')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await upsertInventoryItems('prop_1', [newItem])

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteInventoryItem', () => {
    it('deletes an item scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(deleteInventoryItem('item_1', 'prop_1')).resolves.toBeUndefined()

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory.item.deleted' }))
    })

    it('throws when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(deleteInventoryItem('item_1', 'prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('bulkDeleteInventoryItems', () => {
    it('deletes multiple items scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(bulkDeleteInventoryItems(['item_1', 'item_2'], 'prop_1')).resolves.toBeUndefined()

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory.item.deleted' }))
    })

    it('no-ops without authenticating when no item ids are given', async () => {
      await bulkDeleteInventoryItems([], 'prop_1')

      expect(requireOrgMember).not.toHaveBeenCalled()
    })

    it('throws when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(bulkDeleteInventoryItems(['item_1'], 'prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('completeInventoryStep', () => {
    it('marks the inventory step complete and redirects to the checklist step', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: {} } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(completeInventoryStep('prop_1'))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/checklist')
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(completeInventoryStep('prop_1')).rejects.toThrow('REDIRECT:/login')
    })
  })

  describe('cloneInventoryFromProperty', () => {
    it('copies non-duplicate items to a target property verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_2' } }],
        inventory_items: [
          { data: [{ name: 'Towels', category: 'bath', unit: 'each', par_level: 6, preferred_brand: null, catalog_item_id: null, low_stock_threshold_pct: 20 }] },
          { data: [] },
          { error: null },
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneInventoryFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 1, skipped: 0 })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'property.inventory.cloned' }))
    })

    // Regression test — cloneInventoryFromProperty previously read the
    // existing-items check scoped by org_id (so it silently found nothing
    // for a foreign property) but then inserted new rows using the
    // client-supplied targetPropertyId regardless, without ever verifying
    // that id belonged to the caller's org. See CLAUDE.md's IDOR
    // standing-audit item; fixed in this session.
    it('rejects a target property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneInventoryFromProperty('prop_1', 'other-orgs-property')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Target property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('inventory_items')
    })

    it('errors when the source property has no active inventory items', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_2' } }],
        inventory_items: [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneInventoryFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Source property has no inventory items' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await cloneInventoryFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ added: 0, skipped: 0, error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
