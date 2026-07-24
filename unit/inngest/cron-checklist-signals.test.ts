import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { computeChecklistSignals } from '@/lib/inngest/functions/cron/checklist-signals'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

function makeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.gte    = () => chain
    chain.order  = () => chain
    chain.range  = () => chain
    chain.upsert = () => chain
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: null, error: null }).then(resolve, reject)
    return chain
  })
  return { from }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function completedItem(overrides: Partial<{
  id: string; section_name: string; task: string
  crew_notes: string | null; photo_storage_path: string | null; requires_photo: boolean
  completed_at: string; property_id: string; org_id: string
}> = {}) {
  const {
    id = 'item_1', section_name = 'Kitchen', task = 'Wipe counters',
    crew_notes = null, photo_storage_path = 'photo.jpg', requires_photo = true,
    completed_at = '2026-07-20T10:00:00.000Z', property_id = 'prop_1', org_id = 'org_1',
  } = overrides
  return {
    id, section_name, task, crew_notes, photo_storage_path, requires_photo,
    is_completed: true, completed_at,
    checklist_instances: { property_id, turnovers: { org_id } },
  }
}

describe('computeChecklistSignals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no completed checklist items', async () => {
    const supabase = makeSupabase({ checklist_instance_items: { data: [], error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(computeChecklistSignals, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ computed: 0, photo_required: 0 })
  })

  it('groups completions by property+section+task+org and computes Bayesian flag stats, upserting per group', async () => {
    const upsertedChunks: unknown[][] = []
    const supabase = makeSupabase({
      checklist_instance_items: {
        data: [
          completedItem({ id: 'i1', crew_notes: 'Stain on carpet', completed_at: '2026-07-21T10:00:00.000Z' }),
          completedItem({ id: 'i2', crew_notes: null, photo_storage_path: 'ok.jpg', completed_at: '2026-07-14T10:00:00.000Z' }),
        ],
        error: null,
      },
    })
    // Capture upsert payloads directly off the chain since the generic mock
    // above resolves via `.then()` regardless of which write method ran.
    const originalFrom = supabase.from
    ;(supabase.from as ReturnType<typeof vi.fn>) = vi.fn((table: string) => {
      const chain = originalFrom(table)
      if (table === 'checklist_item_signals') {
        const origUpsert = chain.upsert
        chain.upsert = (payload: unknown[]) => {
          upsertedChunks.push(payload)
          return origUpsert()
        }
      }
      return chain
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(computeChecklistSignals, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ computed: 1, photo_required: 1 })
    expect(upsertedChunks).toHaveLength(1)
    const [signal] = upsertedChunks[0] as Array<Record<string, unknown>>
    expect(signal).toMatchObject({
      org_id:            'org_1',
      property_id:       'prop_1',
      section_name:      'Kitchen',
      task:              'Wipe counters',
      total_completions: 2,
      total_flags:       1,
      // ALPHA_PRIOR(2) + (2 completions - 1 flag) = 3, BETA_PRIOR(1) + 1 flag = 2
      alpha:             3,
      beta:              2,
    })
    // flag_probability = 2/5 = 0.4 >= PHOTO_THRESHOLD(0.2), but only 2 total
    // completions (< 5) so the "limited history" reason branch applies.
    expect(signal.reason).toBe('Flagged 1 of 2 completions (limited history)')
  })

  it('skips items whose checklist_instances or turnovers join is missing (defensive against orphaned rows)', async () => {
    const upsertedChunks: unknown[][] = []
    const supabase = makeSupabase({
      checklist_instance_items: {
        data: [
          { ...completedItem({ id: 'orphan' }), checklist_instances: null },
        ],
        error: null,
      },
    })
    const originalFrom = supabase.from
    ;(supabase.from as ReturnType<typeof vi.fn>) = vi.fn((table: string) => {
      const chain = originalFrom(table)
      if (table === 'checklist_item_signals') {
        const origUpsert = chain.upsert
        chain.upsert = (payload: unknown[]) => {
          upsertedChunks.push(payload)
          return origUpsert()
        }
      }
      return chain
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(computeChecklistSignals, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ computed: 0, photo_required: 0 })
    expect(upsertedChunks).toHaveLength(0)
  })

  it('marks a signal photo_required when the flag probability crosses the 20% threshold', async () => {
    // 3 consecutive flags out of 3 completions → high flag probability and
    // a "consecutive" reason string.
    const items = [
      completedItem({ id: 'f1', crew_notes: 'issue', completed_at: '2026-07-21T10:00:00.000Z' }),
      completedItem({ id: 'f2', crew_notes: 'issue', completed_at: '2026-07-14T10:00:00.000Z' }),
      completedItem({ id: 'f3', crew_notes: 'issue', completed_at: '2026-07-07T10:00:00.000Z' }),
    ]
    const supabase = makeSupabase({
      checklist_instance_items: { data: items, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(computeChecklistSignals, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ computed: 1, photo_required: 1 })
  })
})
