import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { loadUpcomingInspections, UPCOMING_HORIZON_DAYS } from '@/lib/inspections/upcoming-for-dashboard'

// ============================================================================
// THE DASHBOARD'S UPCOMING INSPECTIONS READ.
//
// The selection itself is tested in due-schedules.test.ts — this file is about
// the FETCH, where two things carry weight.
//
// Tenant scope, because this runs under an org-scoped client on the main
// dashboard and a missing filter is one PM's houses on another's screen.
//
// And the difference between "no inspections scheduled" and "the read failed".
// Both would render as an absent section — §9 hides it when empty — so a
// collapsed error is an overdue safety walk invisible behind a dashboard that
// looks entirely healthy. unwrapList throws; this asserts it still does.
// ============================================================================

const ORG   = 'org-1'
const TODAY = '2026-09-15'

interface Spec { data?: unknown; error?: { message: string } | null }

function makeClient(tables: Record<string, Spec>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'not', 'lte', 'gte', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return builder }
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({
        data:  tables[table]?.data ?? [],
        error: tables[table]?.error ?? null,
      }).then(resolve)
      return builder
    },
  } as unknown as SupabaseClient

  return { client, calls }
}

const scheduleRow = (over: Record<string, unknown> = {}) => ({
  id:                 'sched-1',
  property_id:        'prop-1',
  name:               'Safety & Risk Mitigation Inspection',
  next_due_date:      '2026-09-20',
  inspection_form_id: 'form-safety',
  property:           [{ name: 'Lake House' }],
  ...over,
})

describe('loadUpcomingInspections — scope and bounds', () => {
  it('scopes both reads to the org, and to inspection schedules only', async () => {
    const { client, calls } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
    })
    await loadUpcomingInspections(client, ORG, TODAY)

    const scheduleCalls = calls.filter((c) => c.table === 'maintenance_schedules')
    expect(scheduleCalls.map((c) => c.args)).toContainEqual(['org_id', ORG])
    expect(scheduleCalls.map((c) => c.args)).toContainEqual(['creates', 'inspection'])
    // An archived property's schedule must not appear on the dashboard.
    expect(scheduleCalls.map((c) => c.args)).toContainEqual(['is_active', true])

    expect(calls.filter((c) => c.table === 'inspections').map((c) => c.args))
      .toContainEqual(['org_id', ORG])
  })

  it('filters at the DATABASE to the horizon, not only in the selector', async () => {
    // The selector applies the horizon regardless, so this is about not
    // shipping every dormant annual schedule over the wire to discard most.
    const { client, calls } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
    })
    await loadUpcomingInspections(client, ORG, TODAY)

    // 2026-09-15 + 29 days.
    expect(calls.map((c) => c.args)).toContainEqual(['next_due_date', '2026-10-14'])
    expect(UPCOMING_HORIZON_DAYS).toBe(29)
  })

  it('excludes a schedule whose PROPERTY is archived', async () => {
    // archiveProperty sets properties.is_active = false and deliberately leaves
    // maintenance_schedules alone — the schedule is still the right record if
    // the property is un-archived. So filtering only on the schedule's own
    // is_active leaves an archived house showing permanently overdue work
    // nobody intends to do, on the dashboard and in the monthly email both.
    //
    // Asserted at the QUERY, because the filter is server-side: an embedded
    // `.eq('property.is_active', true)` over a `properties!inner(...)` join.
    const { client, calls } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
    })
    await loadUpcomingInspections(client, ORG, TODAY)

    const args = calls.filter((c) => c.table === 'maintenance_schedules').map((c) => c.args)
    expect(args).toContainEqual(['property.is_active', true])
    expect(
      calls.some((c) => c.method === 'select' && String(c.args[0]).includes('properties!inner')),
      'the embed must be an INNER join, or the filter cannot exclude anything',
    ).toBe(true)
  })

  it('bounds every read — max_rows truncates silently', async () => {
    const { client, calls } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
    })
    await loadUpcomingInspections(client, ORG, TODAY)

    for (const table of ['maintenance_schedules', 'inspections']) {
      expect(
        calls.some((c) => c.table === table && c.method === 'limit'),
        `${table} read must be bounded`,
      ).toBe(true)
    }
  })

  it('never queries open walks when no schedule is due', async () => {
    // `.in()` with an empty list is a PostgREST SYNTAX ERROR, not a
    // match-nothing — so the early return is correctness, not an optimisation.
    const { client, calls } = makeClient({ maintenance_schedules: { data: [] } })

    expect(await loadUpcomingInspections(client, ORG, TODAY)).toEqual([])
    expect(calls.some((c) => c.table === 'inspections')).toBe(false)
  })
})

describe('loadUpcomingInspections — what the section renders', () => {
  it('carries the property name through the PostgREST embed', async () => {
    const { client } = makeClient({ maintenance_schedules: { data: [scheduleRow()] } })
    const [row] = await loadUpcomingInspections(client, ORG, TODAY)
    expect(row).toMatchObject({ propertyName: 'Lake House', overdue: false, daysUntil: 5 })
  })

  it('handles the embed arriving as a bare object rather than an array', async () => {
    // PostgREST's shape depends on the relationship it infers, and a nested
    // join that comes back as an object where the code assumed an array is a
    // silent null — the row renders with no property name and nobody notices.
    const { client } = makeClient({
      maintenance_schedules: { data: [scheduleRow({ property: { name: 'Cabin' } })] },
    })
    const [row] = await loadUpcomingInspections(client, ORG, TODAY)
    expect(row!.propertyName).toBe('Cabin')
  })

  it('survives a schedule whose property embed is missing', async () => {
    const { client } = makeClient({
      maintenance_schedules: { data: [scheduleRow({ property: null })] },
    })
    const [row] = await loadUpcomingInspections(client, ORG, TODAY)
    expect(row!.propertyName).toBeNull()
  })

  it('suppresses a schedule whose walk is already open', async () => {
    const { client } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
      inspections:           { data: [{ source_schedule_id: 'sched-1', completed_at: null }] },
    })
    expect(await loadUpcomingInspections(client, ORG, TODAY)).toEqual([])
  })
})

describe('loadUpcomingInspections — an empty org is not a failed read', () => {
  it('returns [] for an org with nothing scheduled', async () => {
    const { client } = makeClient({ maintenance_schedules: { data: [] } })
    expect(await loadUpcomingInspections(client, ORG, TODAY)).toEqual([])
  })

  it('THROWS when the schedule read errors, rather than rendering as empty', async () => {
    // §9 hides the section when empty, so a swallowed error and a healthy org
    // are the same picture. This is the assertion that keeps them apart: the
    // page's error boundary is the right outcome, not a reassuring blank.
    const { client } = makeClient({
      maintenance_schedules: { error: { message: 'connection reset' } },
    })
    await expect(loadUpcomingInspections(client, ORG, TODAY)).rejects.toThrow()
  })

  it('THROWS when the open-walk read errors', async () => {
    // Failing open here would be worse than failing loudly: every suppressed
    // in-progress walk would reappear as due, and a PM tapping Start on one
    // creates a second inspection against a single occurrence.
    const { client } = makeClient({
      maintenance_schedules: { data: [scheduleRow()] },
      inspections:           { error: { message: 'timeout' } },
    })
    await expect(loadUpcomingInspections(client, ORG, TODAY)).rejects.toThrow()
  })
})

vi.mock('server-only', () => ({}))
