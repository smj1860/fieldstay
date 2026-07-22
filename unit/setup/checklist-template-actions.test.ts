import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { applyMasterChecklistToProperties } from '@/app/(dashboard)/setup/checklist-template/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const rpc = vi.fn((): Promise<{ data: unknown; error: unknown }> => Promise.resolve({ data: null, error: null }))
  return { from, rpc }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('setup/checklist-template/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // saveMasterChecklistItems and the org_master_checklist_items table it
  // wrote to were dropped by the Templates Hub refactor on main (see
  // 20260721150000_drop_org_master_checklist_items.sql) — the master
  // checklist concept was superseded by the room-template system, so
  // there's nothing left here to test.

  // These property ids are only ever forwarded into an Inngest event —
  // the actual per-property write happens in
  // lib/inngest/functions/apply-master-checklist.ts, which is fanned out
  // and re-scoped by org there (out of scope for this Server Action test
  // file, matching the established convention for other event-dispatch-only
  // actions such as inventory/actions.ts's triggerShoppingCart).
  describe('applyMasterChecklistToProperties', () => {
    it('queues the apply-to-properties event once the org has room template config', async () => {
      const supabase = makeSupabase({
        organizations:  [{ data: { bedroom_room_template_id: 'room_1', bathroom_room_template_id: null } }],
        room_templates: [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await applyMasterChecklistToProperties(['prop_1', 'prop_2'])

      expect(result).toEqual({ queued: 2 })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'checklist/master-template.apply.requested',
        data: { org_id: 'org_1', property_ids: ['prop_1', 'prop_2'], triggered_by: 'user_1' },
      })
    })

    it('errors without dispatching when the org has no room template library configured', async () => {
      const supabase = makeSupabase({
        organizations:  [{ data: { bedroom_room_template_id: null, bathroom_room_template_id: null } }],
        room_templates: [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await applyMasterChecklistToProperties(['prop_1'])

      expect(result).toEqual({ error: 'No room templates found. Build your room library first.', queued: 0 })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await applyMasterChecklistToProperties(['prop_1'])

      expect(result).toEqual({ error: 'Operation failed. Please try again.', queued: 0 })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
