import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import {
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
  bulkImportCatalogItems,
  type CatalogItemInput,
} from '@/app/admin/inventory-catalog/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

function itemInput(overrides: Partial<CatalogItemInput> = {}): CatalogItemInput {
  return {
    name: 'Paper towels', category: 'paper_goods', default_unit: 'roll',
    default_par_level: 2, par_mode: 'static', smart_group: null, base_qty: 1,
    description: 'Standard 2-ply roll', is_active: true,
    ...overrides,
  }
}

describe('admin/inventory-catalog/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createCatalogItem', () => {
    it('creates a catalog item when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createCatalogItem(itemInput())

      expect(result).toEqual({ id: 'item_1' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'admin_1', action: 'platform_admin.inventory_catalog_item.created', targetId: 'item_1',
      }))
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createCatalogItem(itemInput({ name: '   ' }))

      expect(result).toEqual({ error: 'Item name is required.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await createCatalogItem(itemInput())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('round-trips valid smart config through normalizeParConfig', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      await createCatalogItem(itemInput({ par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2 }))

      const chain = supabase.from.mock.results[0]!.value
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ par_mode: 'smart', smart_group: 'guest_consumable', base_qty: 2 })
      )
    })

    it('never writes a group for a static item, even if one was submitted', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      await createCatalogItem(itemInput({ par_mode: 'static', smart_group: 'bedroom_essential', base_qty: 2 }))

      const chain = supabase.from.mock.results[0]!.value
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ par_mode: 'static', smart_group: null })
      )
    })

    it('degrades smart mode with a null group to static', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      await createCatalogItem(itemInput({ par_mode: 'smart', smart_group: null, base_qty: 2 }))

      const chain = supabase.from.mock.results[0]!.value
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ par_mode: 'static', smart_group: null })
      )
    })
  })

  describe('updateCatalogItem', () => {
    it('updates a catalog item when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await updateCatalogItem('item_1', itemInput())

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'admin_1', action: 'platform_admin.inventory_catalog_item.updated', targetId: 'item_1',
      }))
    })

    it('returns not-found when the item id does not exist', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await updateCatalogItem('missing-item', itemInput())

      expect(result).toEqual({ error: 'Catalog item not found.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await updateCatalogItem('item_1', itemInput({ name: '' }))

      expect(result).toEqual({ error: 'Item name is required.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await updateCatalogItem('item_1', itemInput())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteCatalogItem', () => {
    it('deletes a catalog item when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: { id: 'item_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await deleteCatalogItem('item_1')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'admin_1', action: 'platform_admin.inventory_catalog_item.deleted', targetId: 'item_1',
      }))
    })

    it('returns not-found when the item id does not exist', async () => {
      const supabase = makeSupabase({
        inventory_catalog: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await deleteCatalogItem('missing-item')

      expect(result).toEqual({ error: 'Catalog item not found.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await deleteCatalogItem('item_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('bulkImportCatalogItems', () => {
    it('inserts every valid row and returns the created items', async () => {
      const inserted = [
        { id: 'item_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll', default_par_level: 2, par_mode: 'static', smart_group: null, base_qty: 1, description: null, is_active: true },
      ]
      const supabase = makeSupabase({
        inventory_catalog: [{ data: inserted, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await bulkImportCatalogItems([
        { name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll', default_par_level: 2, description: '' },
      ])

      expect(result.items).toEqual([
        { id: 'item_1', name: 'Paper Towels', category: 'paper_goods', default_unit: 'roll', default_par_level: 2, par_mode: 'static', smart_group: null, base_qty: 1, description: '', is_active: true },
      ])
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.inventory_catalog_item.bulk_imported', metadata: { count: 1 },
      }))
    })

    it('drops rows with a blank name and normalizes a non-positive par level to 1', async () => {
      const inserted = [
        { id: 'item_1', name: 'Trash Bags', category: 'cleaning', default_unit: 'box', default_par_level: 1, par_mode: 'static', smart_group: null, base_qty: 1, description: null, is_active: true },
      ]
      const supabase = makeSupabase({
        inventory_catalog: [{ data: inserted, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await bulkImportCatalogItems([
        { name: '   ', category: 'other', default_unit: 'units', default_par_level: 1, description: '' },
        { name: 'Trash Bags', category: 'cleaning', default_unit: 'box', default_par_level: -3, description: '' },
      ])

      expect(result.items).toHaveLength(1)
      const chain = supabase.from.mock.results[0]!.value
      expect(chain.insert).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'Trash Bags', default_par_level: 1 }),
      ])
    })

    it('returns an error when every row is invalid', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await bulkImportCatalogItems([
        { name: '  ', category: 'other', default_unit: 'units', default_par_level: 1, description: '' },
      ])

      expect(result).toEqual({ error: 'No valid rows to import.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
