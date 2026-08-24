import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  applySafetyTemplate,
  rebaseSafetySchedules,
  SAFETY_SCHEDULE_NAME,
} from '@/lib/inspections/apply-safety-template'

// ============================================================================
// APPLYING THE TEMPLATE — the one function onboarding and the cron share.
//
// Written twice they would drift, and the drift would be invisible: a property
// quietly missing the walk it was supposed to get. So the behaviour that
// matters is tested once, here, and both callers inherit it.
// ============================================================================

const ORG = 'org-1'

interface Table { data?: unknown; error?: { message: string } | null; count?: number }

function makeClient(tables: Record<string, Table>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const writes: { table: string; rows: unknown[]; opts?: unknown }[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return builder }
      }
      builder.upsert = (rows: unknown, opts?: unknown) => {
        writes.push({ table, rows: Array.isArray(rows) ? rows : [rows], opts })
        return {
          select: () => Promise.resolve(
            tables[table]?.error
              ? { data: null, error: tables[table]!.error }
              // Every row lands unless a test says otherwise — the conflict
              // case is modelled by an explicit `upsertResult`.
              : { data: (tables[`${table}:upsertResult`]?.data as unknown[]) ?? (Array.isArray(rows) ? rows : [rows]), error: null },
          ),
        }
      }
      builder.maybeSingle = () => Promise.resolve({
        data:  tables[table]?.data ?? null,
        error: tables[table]?.error ?? null,
      })
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
        data:  tables[table]?.data ?? [],
        error: tables[table]?.error ?? null,
      }).then(resolve)
      return builder
    },
  } as unknown as SupabaseClient

  return { client, calls, writes }
}

const FORMS = { data: [{ id: 'form-safety', version: 1 }] }
const TWO_PROPERTIES = { data: [{ id: 'prop-1' }, { id: 'prop-2' }] }
const TEMPLATE = { frequency: 'semi_annual' as const, startMonth: 3 }
const TODAY = new Date('2026-01-15T12:00:00Z')

describe('applySafetyTemplate', () => {
  it('creates one schedule per property, all on the template’s first date', async () => {
    const { client, writes } = makeClient({
      inspection_forms: FORMS,
      properties:       TWO_PROPERTIES,
    })

    const result = await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    expect(result).toMatchObject({ created: 2, properties: 2 })
    const rows = writes.find((w) => w.table === 'maintenance_schedules')!.rows as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({
        org_id:             ORG,
        name:               SAFETY_SCHEDULE_NAME,
        schedule_type:      'routine',
        frequency:          'semi_annual',
        next_due_date:      '2026-03-01',
        creates:            'inspection',
        inspection_form_id: 'form-safety',
        is_active:          true,
        // Inspections NOTIFY and never auto-create a work order (§7).
        auto_create_wo:     false,
        // Unassigned on purpose — guessing an assignee at onboarding would
        // send a due notification to somebody who never agreed to walk 29
        // properties.
        assigned_to_user_id: null,
      })
    }
    expect(rows.map((r) => r.property_id).sort()).toEqual(['prop-1', 'prop-2'])
  })

  it('collides rather than duplicating — the index is the guarantee', async () => {
    // Three writers apply this rule (onboarding, the cron, a PM by hand), so
    // "read what exists then write what doesn't" would race. ON CONFLICT DO
    // NOTHING against uq_maintenance_schedules_property_inspection_form is
    // what makes that unnecessary.
    const { client, writes } = makeClient({
      inspection_forms: FORMS,
      properties:       TWO_PROPERTIES,
      'maintenance_schedules:upsertResult': { data: [{ id: 'sched-new' }] },
    })

    const result = await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    expect(result.created).toBe(1)
    expect(writes[0]!.opts).toMatchObject({
      onConflict:       'property_id,inspection_form_id',
      ignoreDuplicates: true,
    })
  })

  it('skips ARCHIVED properties', async () => {
    // A property the PM stopped managing must not get a due notification for a
    // house nobody is going to. Same filter the cron's own org fan-out uses.
    const { client, calls } = makeClient({
      inspection_forms: FORMS,
      properties:       TWO_PROPERTIES,
    })
    await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    const propertyEqs = calls.filter((c) => c.table === 'properties' && c.method === 'eq').map((c) => c.args)
    expect(propertyEqs).toContainEqual(['is_active', true])
    expect(propertyEqs).toContainEqual(['org_id', ORG])
  })

  it('does nothing, quietly, when the org has no template', async () => {
    const { client, writes } = makeClient({
      organizations:    { data: { inspection_safety_frequency: null, inspection_safety_start_month: null } },
      inspection_forms: FORMS,
      properties:       TWO_PROPERTIES,
    })

    expect(await applySafetyTemplate(client, ORG, { today: TODAY }))
      .toMatchObject({ created: 0, skipped: 'no_template' })
    expect(writes).toHaveLength(0)
  })

  it('does nothing when the form library has not been seeded', async () => {
    // An org onboarding against an unseeded database should be told nothing
    // was scheduled, not handed a 500.
    const { client, writes } = makeClient({
      inspection_forms: { data: [] },
      properties:       TWO_PROPERTIES,
    })

    expect(await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY }))
      .toMatchObject({ created: 0, skipped: 'no_form' })
    expect(writes).toHaveLength(0)
  })

  it('does nothing for an org with no properties', async () => {
    const { client, writes } = makeClient({
      inspection_forms: FORMS,
      properties:       { data: [] },
    })

    expect(await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY }))
      .toMatchObject({ created: 0, skipped: 'no_properties' })
    expect(writes).toHaveLength(0)
  })

  it('THROWS when the property read errors — that is not "no properties"', async () => {
    // The distinction this whole function turns on. Swallowing it would skip an
    // entire org, silently, on every run — and "no properties" is a legitimate
    // steady state, so the two must not collapse into the same outcome.
    const { client } = makeClient({
      inspection_forms: FORMS,
      properties:       { error: { message: 'connection reset' } },
    })

    await expect(applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY }))
      .rejects.toThrow(/property load failed/)
  })

  it('THROWS when the insert errors', async () => {
    const { client } = makeClient({
      inspection_forms:      FORMS,
      properties:            TWO_PROPERTIES,
      maintenance_schedules: { error: { message: 'deadlock detected' } },
    })

    await expect(applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY }))
      .rejects.toThrow(/fan-out failed/)
  })

  it('bounds the property read', async () => {
    const { client, calls } = makeClient({ inspection_forms: FORMS, properties: TWO_PROPERTIES })
    await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })
    expect(calls.some((c) => c.table === 'properties' && c.method === 'limit')).toBe(true)
  })

  it('takes the HIGHEST active form version, matching what a device would walk', async () => {
    const { client, calls } = makeClient({ inspection_forms: FORMS, properties: TWO_PROPERTIES })
    await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    const formCalls = calls.filter((c) => c.table === 'inspection_forms')
    expect(formCalls.map((c) => c.args)).toContainEqual(['key', 'safety'])
    expect(formCalls.map((c) => c.args)).toContainEqual(['is_active', true])
    expect(formCalls.find((c) => c.method === 'order')!.args)
      .toEqual(['version', { ascending: false }])
  })

  it('loads the template itself when the caller does not supply one', async () => {
    // The cron path: it has an org id and nothing else.
    const { client, writes } = makeClient({
      organizations:    { data: { inspection_safety_frequency: 'annual', inspection_safety_start_month: 6 } },
      inspection_forms: FORMS,
      properties:       TWO_PROPERTIES,
    })

    const result = await applySafetyTemplate(client, ORG, { today: TODAY })
    expect(result.created).toBe(2)
    const rows = writes[0]!.rows as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ frequency: 'annual', next_due_date: '2026-06-01' })
  })
})

describe('rebaseSafetySchedules', () => {
  /** The double records `update` payloads and the filters each one carried. */
  function makeUpdateClient(tables: Record<string, Table>) {
    const updates: { patch: unknown; filters: [string, unknown][] }[] = []
    const client = {
      from(table: string) {
        const filters: [string, unknown][] = []
        const builder: Record<string, unknown> = {}
        for (const m of ['select', 'order', 'limit']) builder[m] = () => builder
        for (const m of ['eq', 'gt']) {
          builder[m] = (col: string, val: unknown) => { filters.push([`${m}:${col}`, val]); return builder }
        }
        builder.update = (patch: unknown) => { updates.push({ patch, filters }); return builder }
        builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
          data: tables[table]?.data ?? [], error: tables[table]?.error ?? null,
        }).then(resolve)
        return builder
      },
    } as unknown as SupabaseClient
    return { client, updates }
  }

  const FORM_ONLY = { inspection_forms: FORMS }

  it('moves the cadence on EVERY safety schedule', async () => {
    const { client, updates } = makeUpdateClient(FORM_ONLY)
    await rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY)

    const freqUpdate = updates.find((u) => 'frequency' in (u.patch as object))!
    expect(freqUpdate.patch).toEqual({ frequency: 'semi_annual' })
    // Scoped to this org's SAFETY inspection schedules and nothing else — a
    // missing form filter would retime the indoor and outdoor walks too.
    expect(freqUpdate.filters).toContainEqual(['eq:org_id', ORG])
    expect(freqUpdate.filters).toContainEqual(['eq:creates', 'inspection'])
    expect(freqUpdate.filters).toContainEqual(['eq:inspection_form_id', 'form-safety'])
    // And NO date filter: the cadence reaches overdue schedules too.
    expect(freqUpdate.filters.some(([k]) => k.startsWith('gt:'))).toBe(false)
  })

  it('moves the DUE DATE only where it is still in the future', async () => {
    // The clause carrying the weight. A date that is today or past means the
    // walk is due or overdue and somebody may be driving to it — re-basing it
    // would either cancel that or re-open a walk completed days ago, producing
    // a duplicate inspection against one occurrence.
    const { client, updates } = makeUpdateClient(FORM_ONLY)
    await rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY)

    const dateUpdate = updates.find((u) => 'next_due_date' in (u.patch as object))!
    expect(dateUpdate.filters).toContainEqual(['gt:next_due_date', '2026-01-15'])
    // 2026-01-15 with a March/September template — the next date that has not
    // gone by.
    expect(dateUpdate.patch).toEqual({ next_due_date: '2026-03-01' })
  })

  it('re-bases FORWARD when today is inside a run month', async () => {
    // The case that separates rebasedSafetyDueDate from firstSafetyDueDate, and
    // the only one where they disagree. On March 20th with a March/September
    // template, the onboarding rule returns March 1st — two weeks in the past —
    // so every future-dated schedule would come back instantly overdue for a
    // walk nobody was told about. Without this case the two are
    // interchangeable and swapping them breaks nothing.
    const { client, updates } = makeUpdateClient(FORM_ONLY)
    await rebaseSafetySchedules(client, ORG, TEMPLATE, new Date('2026-03-20T12:00:00Z'))

    const dateUpdate = updates.find((u) => 'next_due_date' in (u.patch as object))!
    expect(dateUpdate.patch).toEqual({ next_due_date: '2026-09-01' })
  })

  it('does nothing when the form library has not been seeded', async () => {
    const { client, updates } = makeUpdateClient({ inspection_forms: { data: [] } })
    expect(await rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY)).toEqual({ retimed: 0 })
    expect(updates).toHaveLength(0)
  })

  it('THROWS when the cadence update errors', async () => {
    const { client } = makeUpdateClient({
      ...FORM_ONLY,
      maintenance_schedules: { error: { message: 'deadlock detected' } },
    })
    await expect(rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY))
      .rejects.toThrow(/cadence update failed/)
  })
})
