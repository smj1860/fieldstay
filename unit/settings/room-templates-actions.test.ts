import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import {
  createRoomTemplate,
  renameRoomTemplate,
  setRoomTemplateAutoInclude,
  deleteRoomTemplate,
  setBedroomBathroomMapping,
  saveRoomTemplateItems,
} from '@/app/(dashboard)/settings/room-templates/actions'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

interface QueuedByTable {
  [table: string]: unknown[]
}

// See unit/settings/settings-actions.test.ts for the pattern this mirrors.
function makeSupabase(queued: QueuedByTable = {}) {
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
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function mockAuthed(supabase: ReturnType<typeof makeSupabase>, role = 'admin') {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   supabase as never,
    membership: {
      org_id: ORG_ID,
      role,
      org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
    } as never,
  })
}

describe('settings/room-templates/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createRoomTemplate — role gate', () => {
    it('denies a crew-role caller before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'crew')

      const result = await createRoomTemplate('Primary Bedroom')

      expect(result).toEqual({ error: 'Only admins, managers, and owners can manage room templates.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('allows manager and inserts scoped to the caller org_id', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: { id: 'rt_1' }, error: null }] })
      mockAuthed(supabase, 'manager')

      const result = await createRoomTemplate('Primary Bedroom')

      expect(result).toEqual({ id: 'rt_1' })
      const insertCall = supabase.calls.find((c) => c.table === 'room_templates' && c.method === 'insert')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((insertCall!.args[0] as any).org_id).toBe(ORG_ID)
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, action: 'room_template.created' })
      )
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'admin')

      const result = await createRoomTemplate('   ')

      expect(result).toEqual({ error: 'Room name is required.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('propagates a rejected requireOrgMember without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await createRoomTemplate('Primary Bedroom')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })
  })

  describe('renameRoomTemplate — tenant isolation (IDOR)', () => {
    it('scopes the update to the caller org_id and rejects a foreign id', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: null, error: null }] })
      mockAuthed(supabase, 'admin')

      const result = await renameRoomTemplate('rt_other_org', 'New Name')

      expect(result).toEqual({ error: 'Room template not found.' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'room_templates' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'rt_other_org')).toBe(true)
    })

    it('denies a viewer-role caller', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'viewer')

      const result = await renameRoomTemplate('rt_1', 'New Name')

      expect(result.error).toMatch(/admins, managers, and owners/)
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('setRoomTemplateAutoInclude', () => {
    it('scopes the update to the caller org_id', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: { id: 'rt_1' }, error: null }] })
      mockAuthed(supabase, 'admin')

      const result = await setRoomTemplateAutoInclude('rt_1', true)

      expect(result).toEqual({})
      const eqCalls = supabase.calls.filter((c) => c.table === 'room_templates' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    })
  })

  describe('deleteRoomTemplate — tenant isolation (IDOR)', () => {
    it('scopes the delete to the caller org_id and rejects a foreign id', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: null, error: null }] })
      mockAuthed(supabase, 'owner')

      const result = await deleteRoomTemplate('rt_other_org')

      expect(result).toEqual({ error: 'Room template not found.' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'room_templates' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    })

    it('deletes and logs audit event on the happy path', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: { id: 'rt_1' }, error: null }] })
      mockAuthed(supabase, 'owner')

      const result = await deleteRoomTemplate('rt_1')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'room_template.deleted', targetId: 'rt_1' })
      )
    })
  })

  describe('setBedroomBathroomMapping — verifies room template ownership before writing', () => {
    it('rejects when a supplied room template id does not belong to the caller org', async () => {
      const supabase = makeSupabase({
        room_templates: [{ data: [{ id: 'rt_bedroom' }], error: null }], // only 1 of 2 ids "owned"
      })
      mockAuthed(supabase, 'admin')

      const result = await setBedroomBathroomMapping('rt_bedroom', 'rt_bathroom_other_org')

      expect(result).toEqual({ error: 'One or more room templates not found.' })
      // Must never fall through to the organizations write when ownership fails
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('writes via the service client scoped to membership.org_id (not a client-supplied id) once ownership is verified', async () => {
      const supabase = makeSupabase({
        room_templates: [{ data: [{ id: 'rt_bedroom' }, { id: 'rt_bathroom' }], error: null }],
      })
      mockAuthed(supabase, 'admin')
      const serviceSupabase = makeSupabase({ organizations: [{ data: null, error: null }] })
      vi.mocked(createServiceClient).mockReturnValue(serviceSupabase as never)

      const result = await setBedroomBathroomMapping('rt_bedroom', 'rt_bathroom')

      expect(result).toEqual({})
      const eqCall = serviceSupabase.calls.find((c) => c.table === 'organizations' && c.method === 'eq')
      expect(eqCall?.args).toEqual(['id', ORG_ID])
    })

    it('allows null ids (clearing the mapping) without an ownership lookup', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'admin')
      const serviceSupabase = makeSupabase({ organizations: [{ data: null, error: null }] })
      vi.mocked(createServiceClient).mockReturnValue(serviceSupabase as never)

      const result = await setBedroomBathroomMapping(null, null)

      expect(result).toEqual({})
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('saveRoomTemplateItems — tenant isolation (IDOR)', () => {
    it('verifies room template ownership before deleting/inserting items', async () => {
      const supabase = makeSupabase({ room_templates: [{ data: null, error: null }] })
      mockAuthed(supabase, 'admin')

      const result = await saveRoomTemplateItems('rt_other_org', [
        { task: 'Make bed', requires_photo: false, notes: '', sort_order: 0 },
      ])

      expect(result).toEqual({ error: 'Room template not found.', saved: 0 })
      expect(supabase.calls.some((c) => c.table === 'room_template_items')).toBe(false)
    })

    it('replaces items on the happy path once ownership is confirmed', async () => {
      const supabase = makeSupabase({
        room_templates:      [{ data: { id: 'rt_1' }, error: null }],
        room_template_items: [{ data: null, error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase, 'admin')

      const result = await saveRoomTemplateItems('rt_1', [
        { task: 'Make bed', requires_photo: false, notes: '', sort_order: 0 },
      ])

      expect(result).toEqual({ saved: 1 })
      expect(supabase.calls.some((c) => c.table === 'room_template_items' && c.method === 'delete')).toBe(true)
      expect(supabase.calls.some((c) => c.table === 'room_template_items' && c.method === 'insert')).toBe(true)
    })
  })
})
