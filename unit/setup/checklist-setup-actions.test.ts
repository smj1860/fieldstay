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
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
// Pulled in transitively via properties/actions.ts's markStepComplete, used
// by completeChecklistStep — not under test in this file.
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import {
  saveChecklistTemplate,
  completeChecklistStep,
  broadcastChecklistTemplate,
  cloneChecklistFromProperty,
  type ChecklistSectionInput,
} from '@/app/(dashboard)/properties/[id]/setup/checklist/actions'

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
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function section(overrides: Partial<ChecklistSectionInput> = {}): ChecklistSectionInput {
  return {
    name: 'Kitchen', sort_order: 0, room_template_id: null,
    items: [{ task: 'Wipe counters', requires_photo: false, notes: '', sort_order: 0 }],
    ...overrides,
  }
}

describe('properties/[id]/setup/checklist/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('saveChecklistTemplate', () => {
    it('replaces sections for a template verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        checklist_templates:          [{ data: { id: 'tmpl_1' } }],
        checklist_template_sections:  [{ error: null }, { data: [{ id: 'sec_1' }] }],
        checklist_template_items:     [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await saveChecklistTemplate('prop_1', 'tmpl_1', [section()])

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'property.checklist_template.updated',
      }))
    })

    it('creates a new template once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:                   [{ data: { id: 'prop_1' } }],
        checklist_templates:          [{ data: { id: 'tmpl_new' } }],
        checklist_template_sections:  [{ error: null }, { data: [{ id: 'sec_1' }] }],
        checklist_template_items:     [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await saveChecklistTemplate('prop_1', null, [section()])

      expect(result).toEqual({ success: true })
    })

    it('rejects a template id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ checklist_templates: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await saveChecklistTemplate('prop_1', 'other-orgs-template', [section()])

      expect(result).toEqual({ error: 'Checklist template not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('checklist_template_sections')
    })

    // Regression test — resolveTemplateId() previously inserted a new
    // checklist_templates row using the caller's org_id but a
    // client-supplied propertyId that was never verified to belong to that
    // org, even though the templateId branch immediately above it already
    // checks ownership. See CLAUDE.md's IDOR standing-audit item; fixed in
    // this session by adding a matching property-ownership check.
    it('rejects a property id that does not belong to the caller org when creating a new template (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await saveChecklistTemplate('other-orgs-property', null, [section()])

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('checklist_templates')
      expect(supabase.from).not.toHaveBeenCalledWith('checklist_template_sections')
    })

    it('rejects a linked room template id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        checklist_templates: [{ data: { id: 'tmpl_1' } }],
        room_templates:       [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await saveChecklistTemplate(
        'prop_1', 'tmpl_1', [section({ room_template_id: 'other-orgs-room-template' })]
      )

      expect(result).toEqual({ error: 'One or more linked room templates were not found.' })
      expect(supabase.from).not.toHaveBeenCalledWith('checklist_template_sections')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await saveChecklistTemplate('prop_1', 'tmpl_1', [section()])

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('completeChecklistStep', () => {
    it('marks the checklist step complete and redirects to the maintenance step', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: {} } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(completeChecklistStep('prop_1'))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/maintenance')
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(completeChecklistStep('prop_1')).rejects.toThrow('REDIRECT:/login')
    })
  })

  describe('broadcastChecklistTemplate', () => {
    it('dispatches a broadcast event and audit-logs the source property', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        membership, user: { id: 'user_1' },
      } as never)

      const result = await broadcastChecklistTemplate('prop_1', ['prop_2', 'prop_3'])

      expect(result).toEqual({ broadcast: 2 })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'checklist/template-broadcast',
        data: {
          org_id:              'org_1',
          source_property_id:  'prop_1',
          target_property_ids: ['prop_2', 'prop_3'],
          triggered_by:        'user_1',
        },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'property.checklist_template.updated',
      }))
    })

    it('no-ops without dispatching when no target properties are given', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        membership, user: { id: 'user_1' },
      } as never)

      const result = await broadcastChecklistTemplate('prop_1', [])

      expect(result).toEqual({ broadcast: 0 })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await broadcastChecklistTemplate('prop_1', ['prop_2'])

      expect(result).toEqual({ broadcast: 0, error: 'Operation failed. Please try again.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('cloneChecklistFromProperty', () => {
    it('broadcasts to the single target property and adds a clone-specific audit entry', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        membership, user: { id: 'user_1' },
      } as never)

      const result = await cloneChecklistFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ broadcast: 1 })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'property.checklist.cloned',
        targetId: 'prop_2',
      }))
    })

    it('propagates the underlying broadcast error without adding a clone audit entry', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await cloneChecklistFromProperty('prop_1', 'prop_2')

      expect(result).toEqual({ broadcast: 0, error: 'Operation failed. Please try again.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })
  })
})
