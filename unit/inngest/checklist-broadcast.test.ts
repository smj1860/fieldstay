import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { broadcastChecklistTemplateJob } from '@/lib/inngest/functions/checklist-broadcast'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order, regardless of whether the chain
// terminates in .single()/.maybeSingle() or is awaited directly (`.then`).
// The function re-queries `checklist_template_sections` multiple times
// per target property (existing-select, delete, per-section insert) so a
// fixed per-table canned response (as in the simpler reference tests)
// isn't enough here — order matters.
function makeSupabase(
  queued: Record<string, { data?: unknown; error?: unknown }[]>,
  // The default-template write goes through the upsert_default_checklist_template
  // RPC, not `.from('checklist_templates').upsert(...)` — the partial index it
  // arbitrates on ((property_id) WHERE is_default) cannot be named by
  // PostgREST's column-list onConflict, and the old spelling threw 42P10 on
  // every target. Queued per call so a test can hand back a different template
  // id per target property.
  rpcQueued: Record<string, { data?: unknown; error?: unknown }[]> = {},
) {
  const counters: Record<string, number> = {}
  const rpcCounters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ table: `rpc:${fn}`, method: 'rpc', args: [args] })
    const idx = rpcCounters[fn] ?? 0
    rpcCounters[fn] = idx + 1
    return Promise.resolve(rpcQueued[fn]?.[idx] ?? { data: null, error: null })
  })

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, rpc, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const sourceTemplate = {
  id:   'tmpl_src',
  name: 'Default Clean',
  checklist_template_sections: [
    {
      name: 'Kitchen', sort_order: 1, requires_section_photo: false,
      checklist_template_items: [
        { task: 'Wipe counters', requires_photo: false, notes: null, sort_order: 1 },
      ],
    },
  ],
}

describe('broadcastChecklistTemplateJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no target properties to broadcast to', async () => {
    const supabase = makeSupabase({
      checklist_templates: [{ data: sourceTemplate, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastChecklistTemplateJob, {
      event: { data: { org_id: 'org_1', source_property_id: 'prop_src', target_property_ids: [], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ broadcast: 0 })
    // Only the source-template load — the target loop body never runs.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns an error and broadcasts nothing when the source template is missing', async () => {
    const supabase = makeSupabase({
      checklist_templates: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastChecklistTemplateJob, {
      event: { data: { org_id: 'org_1', source_property_id: 'prop_src', target_property_ids: ['prop_tgt'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ error: 'Source template not found', broadcast: 0 })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('skips the delete-then-insert rebuild when the target already matches the source exactly', async () => {
    const matchingExistingSections = [
      {
        name: 'Kitchen', sort_order: 1, requires_section_photo: false,
        checklist_template_items: [
          { task: 'Wipe counters', requires_photo: false, notes: null, sort_order: 1 },
        ],
      },
    ]
    const supabase = makeSupabase({
      checklist_templates: [
        { data: sourceTemplate, error: null },              // load-source-template
      ],
      checklist_template_sections: [
        { data: matchingExistingSections, error: null },     // existing-sections select — matches signature
      ],
    }, {
      // The RPC returns the template id as a bare scalar, not a row.
      upsert_default_checklist_template: [{ data: 'tmpl_new', error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastChecklistTemplateJob, {
      event: { data: { org_id: 'org_1', source_property_id: 'prop_src', target_property_ids: ['prop_tgt'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ broadcast: 1 })
    // Only the existing-sections select happened — no delete, no insert.
    const sectionWriteCalls = supabase.calls.filter(
      (c) => c.table === 'checklist_template_sections' && ['delete', 'insert'].includes(c.method),
    )
    expect(sectionWriteCalls).toHaveLength(0)
    expect(supabase.calls.some((c) => c.table === 'checklist_template_items')).toBe(false)
  })

  it('does a full delete-then-insert rebuild when the target template differs from the source', async () => {
    const supabase = makeSupabase({
      checklist_templates: [
        { data: sourceTemplate, error: null },
      ],
      checklist_template_sections: [
        { data: [], error: null },                    // no existing sections — mismatch
        { data: null, error: null },                  // delete
        { data: { id: 'sec_new' }, error: null },      // insert new section .select().single()
      ],
      checklist_template_items: [
        { data: null, error: null },                  // insert items
      ],
    }, {
      upsert_default_checklist_template: [{ data: 'tmpl_new', error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(broadcastChecklistTemplateJob, {
      event: { data: { org_id: 'org_1', source_property_id: 'prop_src', target_property_ids: ['prop_tgt'], triggered_by: 'user_1' } },
      step:  runAllStep(),
    })

    expect(result).toEqual({ broadcast: 1 })
    const sectionWriteCalls = supabase.calls.filter(
      (c) => c.table === 'checklist_template_sections' && ['delete', 'insert'].includes(c.method),
    )
    expect(sectionWriteCalls.map((c) => c.method)).toEqual(['delete', 'insert'])

    const itemInsert = supabase.calls.find((c) => c.table === 'checklist_template_items' && c.method === 'insert')
    expect(itemInsert?.args[0]).toEqual([
      expect.objectContaining({
        section_id:     'sec_new',
        template_id:    'tmpl_new',
        task:           'Wipe counters',
        requires_photo: false,
        notes:          null,
        sort_order:     1,
      }),
    ])
  })
})
