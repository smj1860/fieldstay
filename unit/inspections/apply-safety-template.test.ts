import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import {
  applySafetyTemplate,
  rebaseSafetySchedules,
  SAFETY_SCHEDULE_NAME,
  MAX_PROPERTIES,
} from '@/lib/inspections/apply-safety-template'
import { reportError } from '@/lib/observability/report-error'

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

describe('applySafetyTemplate — MAX_PROPERTIES cap-hit signal', () => {
  // The result set exactly filling the bound used to be silent: every
  // property past the cap never gets a safety schedule, forever (there is
  // no separate "catch what was missed" mechanism — the nightly rebase
  // pass only re-times schedules that already exist), with nothing in the
  // returned ApplyResult or anywhere else to say so.
  const manyProperties = { data: Array.from({ length: MAX_PROPERTIES }, (_, i) => ({ id: `prop-${i}` })) }

  it('does NOT report when the org has fewer properties than the cap', async () => {
    vi.clearAllMocks()
    const { client } = makeClient({ inspection_forms: FORMS, properties: TWO_PROPERTIES })
    await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })
    expect(reportError).not.toHaveBeenCalled()
  })

  it('REPORTS a warning when the result set exactly fills the cap', async () => {
    vi.clearAllMocks()
    const { client } = makeClient({ inspection_forms: FORMS, properties: manyProperties })
    await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ orgId: ORG, level: 'warning' }),
    )
    const [err] = vi.mocked(reportError).mock.calls[0]!
    expect((err as Error).message).toContain(String(MAX_PROPERTIES))
  })

  it('still creates schedules for the properties it DID read, even while reporting the cap', async () => {
    vi.clearAllMocks()
    const { client } = makeClient({ inspection_forms: FORMS, properties: manyProperties })
    const result = await applySafetyTemplate(client, ORG, { template: TEMPLATE, today: TODAY })

    expect(result.properties).toBe(MAX_PROPERTIES)
    expect(result.created).toBe(MAX_PROPERTIES)
  })
})

describe('rebaseSafetySchedules', () => {
  // Both writes (frequency + next_due_date) now happen atomically inside the
  // rebase_safety_schedules RPC — see 20260915158000_rebase_safety_schedules_
  // atomic.sql — rather than as two separate, non-transactional UPDATEs a
  // failure between could leave permanently disagreeing. The test boundary
  // moves with it: what's observable from here is the RPC call's arguments
  // and return value, not individual UPDATE filters.
  function makeRpcClient(tables: Record<string, Table>, rpcResult: Table = {}) {
    const rpcCalls: { fn: string; args: unknown }[] = []
    const client = {
      from(table: string) {
        const builder: Record<string, unknown> = {}
        for (const m of ['select', 'order', 'limit']) builder[m] = () => builder
        for (const m of ['eq', 'gt']) builder[m] = () => builder
        builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
          data: tables[table]?.data ?? [], error: tables[table]?.error ?? null,
        }).then(resolve)
        return builder
      },
      rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args })
        return Promise.resolve({ data: rpcResult.data ?? null, error: rpcResult.error ?? null })
      },
    } as unknown as SupabaseClient
    return { client, rpcCalls }
  }

  const FORM_ONLY = { inspection_forms: FORMS }

  it('calls the atomic RPC with the org, form, cadence, due date and today scoped to this org\'s SAFETY form', async () => {
    const { client, rpcCalls } = makeRpcClient(FORM_ONLY, { data: 2 })
    const result = await rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY)

    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]!.fn).toBe('rebase_safety_schedules')
    expect(rpcCalls[0]!.args).toEqual({
      p_org_id:    ORG,
      p_form_id:   'form-safety',
      p_frequency: 'semi_annual',
      // 2026-01-15 with a March/September template — the next date that has
      // not gone by.
      p_due_date:  '2026-03-01',
      p_today:     '2026-01-15',
    })
    // The RPC's own row count, not a second local computation.
    expect(result).toEqual({ retimed: 2 })
  })

  it('re-bases FORWARD when today is inside a run month', async () => {
    // The case that separates rebasedSafetyDueDate from firstSafetyDueDate, and
    // the only one where they disagree. On March 20th with a March/September
    // template, the onboarding rule returns March 1st — two weeks in the past —
    // so every future-dated schedule would come back instantly overdue for a
    // walk nobody was told about. Without this case the two are
    // interchangeable and swapping them breaks nothing.
    const { client, rpcCalls } = makeRpcClient(FORM_ONLY, { data: 0 })
    await rebaseSafetySchedules(client, ORG, TEMPLATE, new Date('2026-03-20T12:00:00Z'))

    expect((rpcCalls[0]!.args as { p_due_date: string }).p_due_date).toBe('2026-09-01')
  })

  it('does nothing when the form library has not been seeded', async () => {
    const { client, rpcCalls } = makeRpcClient({ inspection_forms: { data: [] } })
    expect(await rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY)).toEqual({ retimed: 0 })
    expect(rpcCalls).toHaveLength(0)
  })

  it('THROWS when the RPC errors', async () => {
    const { client } = makeRpcClient(FORM_ONLY, { error: { message: 'deadlock detected' } })
    await expect(rebaseSafetySchedules(client, ORG, TEMPLATE, TODAY))
      .rejects.toThrow(/cadence rebase failed/)
  })
})
