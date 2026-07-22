import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import {
  createSeedTemplate,
  renameSeedTemplate,
  setSeedTemplateAutoInclude,
  deleteSeedTemplate,
  saveSeedTemplateItems,
  type SeedTemplateItemInput,
} from '@/app/admin/seed-templates/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

describe('admin/seed-templates/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSeedTemplate', () => {
    it('creates a template appended after the current max sort_order', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [
          { data: { sort_order: 3 } },              // max lookup
          { data: { id: 'tmpl_1' }, error: null },  // insert
        ],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createSeedTemplate('Kitchen')

      expect(result).toEqual({ id: 'tmpl_1' })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'admin_1', action: 'platform_admin.seed_template.created', targetId: 'tmpl_1',
      }))
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await createSeedTemplate('   ')

      expect(result).toEqual({ error: 'Template name is required.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await createSeedTemplate('Kitchen')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('renameSeedTemplate', () => {
    it('renames a template when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await renameSeedTemplate('tmpl_1', 'Bathroom')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.seed_template.updated', targetId: 'tmpl_1',
      }))
    })

    it('returns not-found when the template id does not exist', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await renameSeedTemplate('missing-tmpl', 'Bathroom')

      expect(result).toEqual({ error: 'Template not found.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await renameSeedTemplate('tmpl_1', '  ')

      expect(result).toEqual({ error: 'Template name is required.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await renameSeedTemplate('tmpl_1', 'Bathroom')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('setSeedTemplateAutoInclude', () => {
    it('toggles auto_include when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await setSeedTemplateAutoInclude('tmpl_1', true)

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.seed_template.updated', metadata: { auto_include: true },
      }))
    })

    it('returns not-found when the template id does not exist', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await setSeedTemplateAutoInclude('missing-tmpl', true)

      expect(result).toEqual({ error: 'Template not found.' })
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await setSeedTemplateAutoInclude('tmpl_1', true)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteSeedTemplate', () => {
    it('deletes a template when the caller is a platform admin', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: { id: 'tmpl_1' }, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await deleteSeedTemplate('tmpl_1')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.seed_template.deleted', targetId: 'tmpl_1',
      }))
    })

    it('returns not-found when the template id does not exist', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: null, error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await deleteSeedTemplate('missing-tmpl')

      expect(result).toEqual({ error: 'Template not found.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await deleteSeedTemplate('tmpl_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('saveSeedTemplateItems', () => {
    function items(): SeedTemplateItemInput[] {
      return [{ task: 'Wipe counters', requires_photo: false, notes: '', sort_order: 0 }]
    }

    it('replaces a template’s items when the template exists', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates:      [{ data: { id: 'tmpl_1' } }],
        platform_seed_room_template_items: [{ error: null }, { error: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await saveSeedTemplateItems('tmpl_1', items())

      expect(result).toEqual({ saved: 1 })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.seed_template.updated', targetId: 'tmpl_1', metadata: { saved: 1 },
      }))
    })

    it('rejects a template id that does not exist (IDOR/not-found check)', async () => {
      const supabase = makeSupabase({
        platform_seed_room_templates: [{ data: null }],
      })
      vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase, user: { id: 'admin_1' } } as never)

      const result = await saveSeedTemplateItems('missing-tmpl', items())

      expect(result).toEqual({ error: 'Template not found.', saved: 0 })
      expect(supabase.from).not.toHaveBeenCalledWith('platform_seed_room_template_items')
    })

    it('returns a generic error and never touches the DB when the caller is not a platform admin', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error('REDIRECT:/ops'))

      const result = await saveSeedTemplateItems('tmpl_1', items())

      expect(result).toEqual({ error: 'Operation failed. Please try again.', saved: 0 })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
