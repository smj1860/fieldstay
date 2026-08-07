import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/checklists/seed-default-room-templates', () => ({
  seedDefaultRoomTemplatesIfNeeded: vi.fn(),
}))

import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import type { SupabaseClient } from '@supabase/supabase-js'

const PROPERTY_ID = 'prop_1'
const ORG_ID      = 'org_1'

/** Enough room-template data for composeSections to produce one section. */
const ORG_ROOM_DATA = {
  bedroomRoomTemplateId:  null,
  bathroomRoomTemplateId: null,
  roomTemplates:          [{ id: 'rt_1', name: 'Kitchen', auto_include: true }],
  itemsByTemplate:        { rt_1: [{ id: 'rti_1', label: 'Wipe counters', sort_order: 0 }] },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

/**
 * Per-table queued responses. `checklist_templates` is read for the
 * already-has-a-default guard and then written, so order matters.
 */
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string) => { calls.push({ table, method }); return chain }
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
      chain[m] = (..._a: unknown[]) => record(m)
    }
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }
    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      resolveNext().then(res, rej)
    return chain
  })

  return { from, calls } as unknown as SupabaseClient & { calls: { table: string; method: string }[] }
}

const PROPERTY_ROW = { data: { bedrooms: 2, bathrooms: 1 }, error: null }

describe('applyMasterChecklistToProperty — the already-has-a-default guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates nothing when the property already has a default template and force is false', async () => {
    const supabase = makeSupabase({
      properties:          [PROPERTY_ROW],
      checklist_templates: [{ data: { id: 'tmpl_existing' }, error: null }],
    })

    await applyMasterChecklistToProperty(PROPERTY_ID, ORG_ID, supabase, {
      force: false, orgRoomData: ORG_ROOM_DATA, skipSeed: true,
    })

    // Every automatic caller (property creation, OwnerRez sync, Hospitable
    // sync) passes force:false precisely so a PM's customised template is
    // never clobbered.
    expect(supabase.calls.some((c) => c.table === 'checklist_templates' && c.method === 'insert')).toBe(false)
  })

  it('THROWS when the guard read itself fails, instead of creating a second default template', async () => {
    const supabase = makeSupabase({
      properties: [PROPERTY_ROW],
      checklist_templates: [
        { data: null, error: { message: 'connection reset', code: '08006' } },
      ],
    })

    // This is the compounding one. The guard read discarded its error, so a
    // transient failure made `existingTemplate` null, `if (existingTemplate &&
    // !force)` evaluated false, and the function created a SECOND default
    // template for a property that already had one.
    //
    // It snowballed rather than settling: with two rows the guard's
    // .maybeSingle() then errored on EVERY subsequent run — discarded the same
    // way — so each run added another. The property ends up with a
    // non-deterministic checklist and a customised template shadowed by a
    // freshly seeded default.
    await expect(
      applyMasterChecklistToProperty(PROPERTY_ID, ORG_ID, supabase, {
        force: false, orgRoomData: ORG_ROOM_DATA, skipSeed: true,
      })
    ).rejects.toThrow(/Supabase query failed/)

    expect(supabase.calls.some((c) => c.table === 'checklist_templates' && c.method === 'insert')).toBe(false)
  })

  it('proceeds to create a template when the guard read genuinely finds none', async () => {
    const supabase = makeSupabase({
      properties:          [PROPERTY_ROW],
      checklist_templates: [
        { data: null, error: null },                    // no existing default — a real miss
        { data: { id: 'tmpl_new' }, error: null },      // the insert
      ],
      // The composed "Kitchen" section, and its items, so the run completes.
      checklist_template_sections: [{ data: { id: 'sec_1' }, error: null }],
      checklist_template_items:    [{ data: null, error: null }],
    })

    await applyMasterChecklistToProperty(PROPERTY_ID, ORG_ID, supabase, {
      force: false, orgRoomData: ORG_ROOM_DATA, skipSeed: true,
    })

    // "No row" and "the read failed" must lead to opposite outcomes; this is
    // the half that has to keep working after the fix above.
    expect(supabase.calls.some((c) => c.table === 'checklist_templates' && c.method === 'insert')).toBe(true)
  })
})
