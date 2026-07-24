import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { hospPropertyMerge } from '@/lib/inngest/functions/hospitable/property-merge'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// The whole function is a single step.run('remap-or-flag', ...) — running it
// for real (rather than an allowlist stub) exercises the actual
// select/select/update control flow, with only Supabase and the audit
// logger mocked at the module boundary.
function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

// Queue-based Supabase mock (see checklist-broadcast.test.ts for the
// canonical explanation): each `.from(table)` call consumes the next queued
// response for that table, in call order.
function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const EVENT_DATA = {
  provider_id:          'hospitable',
  previous_external_id: 'hosp_old',
  new_external_id:      'hosp_new',
  triggered_at:          '2026-07-22T10:00:00.000Z',
}

describe('hospPropertyMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renames the surviving external_id in place when no property already exists under new_external_id', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null }, // previousProperty lookup
        { data: null, error: null },                                                  // existingNewProperty lookup — none
        { error: null },                                                              // update external_id
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'remapped', propertyId: 'prop_1' })

    const update = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ external_id: 'hosp_new' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('is a no-op (skipped) when no FieldStay property exists for previous_external_id — safe to re-run after the rename already applied', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: null, error: null }, // previousProperty lookup — already renamed by an earlier run, or never existed
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'skipped', reason: 'no_previous_property' })
    // Only the one lookup happened — no second lookup, no update, no audit log.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('flags for manual review and deactivates the old row instead of silently merging two already-distinct properties', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: { id: 'prop_old', org_id: 'org_1', name: 'Lakehouse' }, error: null }, // previousProperty
        { data: { id: 'prop_new' }, error: null },                                      // existingNewProperty — collision
        { error: null },                                                                // deactivate update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({
      action:              'flagged_for_manual_review',
      previousPropertyId:  'prop_old',
      survivingPropertyId: 'prop_new',
    })

    const deactivate = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
    expect(deactivate?.args[0]).toMatchObject({ is_active: false })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'property.merge_conflict',
        targetType: 'property',
        targetId:   'prop_old',
        metadata: expect.objectContaining({
          provider:              'hospitable',
          previous_external_id: 'hosp_old',
          new_external_id:      'hosp_new',
          surviving_property_id: 'prop_new',
        }),
      }),
    )
  })

  it('throws when the external_id update itself fails, instead of returning a false "remapped" result', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null },
        { data: null, error: null },
        { error: { message: 'constraint violation' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('Property external_id remap failed: constraint violation')
  })
})
