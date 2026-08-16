import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Checklist counted-section top-up.
//
// THE DEFECT: applyMasterChecklistToProperty composes N bedroom sections where
// N = properties.bedrooms, and only ever runs on property creation or a PMS
// initial sync. Correcting the count afterwards recomputed inventory pars (via
// inventory/par-recompute-requested) but left the checklist alone — so a
// property imported with the wrong bedroom count kept a checklist built for
// the wrong count permanently. Guaranteed on every Hostex import, since its
// /properties exposes no bedroom count at all.
//
// ADDITIVE ONLY, mirroring applyRoomQuantities() in checklist-builder.tsx.
// Lowering a count must NOT delete sections: they can hold crew-customised
// items, and deleting them to satisfy arithmetic destroys that silently.
// ============================================================================

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/checklists/apply-master-template', () => ({ fetchOrgRoomTemplateData: vi.fn() }))

import { syncChecklistRoomCounts } from '@/lib/checklists/sync-room-counts'

const BEDROOM_TPL  = 'tpl-bedroom'
const BATHROOM_TPL = 'tpl-bathroom'

const ROOM_DATA = {
  bedroomRoomTemplateId:  BEDROOM_TPL,
  bathroomRoomTemplateId: BATHROOM_TPL,
  roomTemplates: [
    { id: BEDROOM_TPL,  name: 'Bedroom' },
    { id: BATHROOM_TPL, name: 'Bathroom' },
  ],
  itemsByTemplate: {
    [BEDROOM_TPL]: [{ task: 'Strip bed', requires_photo: false, notes: null, sort_order: 0 }],
  },
} as never

/**
 * Records what was written. Models the batched shape the implementation uses:
 * ONE insert of every missing section (read back via .select()), then ONE
 * insert of all their items — not a write per section.
 */
function stubSupabase(opts: {
  template?: { id: string } | null
  sections?: Array<{ id: string; room_template_id: string | null; sort_order: number }>
}) {
  const inserted: Array<Record<string, unknown>> = []
  const itemInserts: Array<Record<string, unknown>[]> = []
  const writes: string[] = []
  let table = ''
  /** Rows an in-flight insert should read back; null when no insert is pending. */
  let pendingCreated: Array<Record<string, unknown>> | null = null

  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self, eq: self, limit: self,
    insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[]
      writes.push(table)
      if (table === 'checklist_template_sections') {
        pendingCreated = rows.map((r, i) => ({
          id:               `sec-${inserted.length + i}`,
          room_template_id: r.room_template_id,
        }))
        inserted.push(...rows)
      } else {
        itemInserts.push(rows)
        pendingCreated = []
      }
      return chain
    },
    single:     async () => ({ data: { id: 'tmpl-1' }, error: null }),
    maybeSingle: async () => ({ data: opts.template ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => {
      if (pendingCreated !== null) {
        const created = pendingCreated
        pendingCreated = null
        return resolve({ data: created, error: null })
      }
      return resolve({
        data:  table === 'checklist_template_sections' ? (opts.sections ?? []) : [],
        error: null,
      })
    },
  })

  const supabase = { from: (t: string) => { table = t; return chain } } as never
  return { supabase, inserted, itemInserts, writes }
}

beforeEach(() => vi.clearAllMocks())

describe('syncChecklistRoomCounts', () => {
  it('adds the missing bedroom sections when the count grows 1 -> 4', async () => {
    // The Hostex case exactly: imported at the 1-bedroom default, corrected
    // to 4 by the PM.
    const { supabase, inserted } = stubSupabase({
      template: { id: 'tmpl-1' },
      sections: [{ id: 's1', room_template_id: BEDROOM_TPL, sort_order: 0 }],
    })

    const result = await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 4, bathrooms: 0 }, ROOM_DATA)

    expect(result.added).toBe(3)
    expect(inserted.map((s) => s.name)).toEqual(['Bedroom 2', 'Bedroom 3', 'Bedroom 4'])
    // Appended after the existing section, never renumbering it.
    expect(inserted.map((s) => s.sort_order)).toEqual([1, 2, 3])
  })

  it('copies the room template items into each new section', async () => {
    const { supabase, itemInserts } = stubSupabase({ template: { id: 'tmpl-1' }, sections: [] })

    await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 2, bathrooms: 0 }, ROOM_DATA)

    // A section with no items is one the crew sees and cannot act on. One
    // insert carrying both sections' items, not one insert per section.
    expect(itemInserts).toHaveLength(1)
    expect(itemInserts[0]).toHaveLength(2)
    expect(itemInserts[0]![0]).toMatchObject({ task: 'Strip bed', requires_photo: false })
  })

  it('writes twice no matter how many sections are missing', async () => {
    // The n+1 shape unit/guardrails/n-plus-one-loops.test.ts exists to catch:
    // correcting a studio to an eight-bedroom must not issue sixteen round
    // trips inside a user-facing save.
    const { supabase, writes } = stubSupabase({ template: { id: 'tmpl-1' }, sections: [] })

    await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 8, bathrooms: 0 }, ROOM_DATA)

    expect(writes).toEqual(['checklist_template_sections', 'checklist_template_items'])
  })

  it('does NOTHING when the checklist already matches', async () => {
    const { supabase, inserted } = stubSupabase({
      template: { id: 'tmpl-1' },
      sections: [
        { id: 's1', room_template_id: BEDROOM_TPL, sort_order: 0 },
        { id: 's2', room_template_id: BEDROOM_TPL, sort_order: 1 },
      ],
    })

    const result = await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 2, bathrooms: 0 }, ROOM_DATA)

    expect(result.added).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('NEVER removes sections when the count drops', async () => {
    // A surplus section can hold crew-customised items. Deleting it to satisfy
    // arithmetic destroys that silently; leaving it costs one visible,
    // reversible click in the builder.
    const { supabase, inserted } = stubSupabase({
      template: { id: 'tmpl-1' },
      sections: [
        { id: 's1', room_template_id: BEDROOM_TPL, sort_order: 0 },
        { id: 's2', room_template_id: BEDROOM_TPL, sort_order: 1 },
        { id: 's3', room_template_id: BEDROOM_TPL, sort_order: 2 },
      ],
    })

    const result = await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 1, bathrooms: 0 }, ROOM_DATA)

    expect(result.added).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('counts bedroom and bathroom sections independently', async () => {
    const { supabase, inserted } = stubSupabase({
      template: { id: 'tmpl-1' },
      sections: [{ id: 's1', room_template_id: BEDROOM_TPL, sort_order: 0 }],
    })

    await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 2, bathrooms: 2 }, ROOM_DATA)

    expect(inserted.map((s) => s.name)).toEqual(['Bedroom 2', 'Bathroom 1', 'Bathroom 2'])
  })

  it('no-ops for a property with no default checklist yet', async () => {
    // Creation or the next sync will compose it from the corrected counts.
    const { supabase, inserted } = stubSupabase({ template: null })

    const result = await syncChecklistRoomCounts('prop-1', 'org-1', supabase, { bedrooms: 4, bathrooms: 2 }, ROOM_DATA)

    expect(result.added).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('swallows a failure rather than rejecting a save that already committed', async () => {
    const exploding = { from: () => { throw new Error('db down') } } as never

    await expect(
      syncChecklistRoomCounts('prop-1', 'org-1', exploding, { bedrooms: 4, bathrooms: 1 }, ROOM_DATA),
    ).resolves.toEqual({ added: 0 })
  })
})
