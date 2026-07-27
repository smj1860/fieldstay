import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))

import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import {
  createPlatformInventoryTemplate,
  renamePlatformInventoryTemplate,
  deletePlatformInventoryTemplate,
  savePlatformInventoryTemplateItems,
  broadcastPlatformInventoryTemplate,
  listOrgsForBroadcast,
} from '@/app/admin/inventory-templates/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const rpc = vi.fn(() => Promise.resolve(queue.__rpc__?.shift() ?? { data: null, error: null }))
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, rpc }
}

describe('admin/inventory-templates/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createPlatformInventoryTemplate', () => {
    it('creates a template when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createPlatformInventoryTemplate('Standard FieldStay Inventory Template', 'desc')

      expect(result).toEqual({ id: 'tmpl_1' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.inventory_template.created',
        targetId: 'tmpl_1',
      }))
    })

    it('rejects a blank name', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createPlatformInventoryTemplate('   ', '')
      expect(result.error).toBeTruthy()
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('surfaces a friendly error on a duplicate name', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: null, error: { code: '23505' } }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createPlatformInventoryTemplate('Standard', '')
      expect(result.error).toMatch(/already exists/)
    })
  })

  describe('renamePlatformInventoryTemplate', () => {
    it('renames when found', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await renamePlatformInventoryTemplate('tmpl_1', 'New Name', '')
      expect(result).toEqual({})
    })

    it('returns not-found when the template does not exist', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await renamePlatformInventoryTemplate('tmpl_missing', 'New Name', '')
      expect(result.error).toBe('Template not found.')
    })
  })

  describe('deletePlatformInventoryTemplate', () => {
    it('deletes when found', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await deletePlatformInventoryTemplate('tmpl_1')
      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.inventory_template.deleted' }))
    })
  })

  describe('savePlatformInventoryTemplateItems', () => {
    it('replaces items via the atomic RPC', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: { id: 'tmpl_1' }, error: null }],
        __rpc__: [{ data: 2, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await savePlatformInventoryTemplateItems('tmpl_1', [
        { catalog_item_id: 'cat_1', par_level: 2, preferred_brand: 'Bounty', sort_order: 0 },
      ])

      expect(result).toEqual({ saved: 1 })
      expect(supabase.rpc).toHaveBeenCalledWith('replace_platform_inventory_template_items', expect.objectContaining({
        p_template_id: 'tmpl_1',
      }))
    })

    it('normalizes a non-positive par_level to 1', async () => {
      const supabase = makeSupabase({
        platform_inventory_templates: [{ data: { id: 'tmpl_1' }, error: null }],
        __rpc__: [{ data: 1, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      await savePlatformInventoryTemplateItems('tmpl_1', [
        { catalog_item_id: 'cat_1', par_level: -5, preferred_brand: '', sort_order: 0 },
      ])

      expect(supabase.rpc).toHaveBeenCalledWith('replace_platform_inventory_template_items', {
        p_template_id: 'tmpl_1',
        p_items: [expect.objectContaining({ par_level: 1 })],
      })
    })
  })

  describe('broadcastPlatformInventoryTemplate', () => {
    it('dispatches an inngest event for "all"', async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: 'admin_1' } } as never)

      const result = await broadcastPlatformInventoryTemplate('tmpl_1', { mode: 'all' })

      expect(result).toEqual({ dispatched: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'platform_inventory_template/broadcast_requested',
        data: { platform_template_id: 'tmpl_1', target_org_ids: null, requested_by: 'admin_1' },
      })
    })

    it('dispatches an inngest event for a selected org list', async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: 'admin_1' } } as never)

      const result = await broadcastPlatformInventoryTemplate('tmpl_1', { mode: 'selected', orgIds: ['org_1', 'org_2'] })

      expect(result).toEqual({ dispatched: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'platform_inventory_template/broadcast_requested',
        data: { platform_template_id: 'tmpl_1', target_org_ids: ['org_1', 'org_2'], requested_by: 'admin_1' },
      })
    })

    it('rejects an empty selected-org list without dispatching', async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: 'admin_1' } } as never)

      const result = await broadcastPlatformInventoryTemplate('tmpl_1', { mode: 'selected', orgIds: [] })

      expect(result.error).toBeTruthy()
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('listOrgsForBroadcast', () => {
    it('returns orgs via the service-role client', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: [{ id: 'org_1', name: 'Lake Martin Rentals' }], error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: 'admin_1' } } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await listOrgsForBroadcast()

      expect(result).toEqual({ orgs: [{ id: 'org_1', name: 'Lake Martin Rentals' }] })
      expect(createServiceClient).toHaveBeenCalledWith({ platformAdmin: { id: 'admin_1' } })
    })
  })
})
