import { describe, it, expect } from 'vitest'
import { checkDemoOfflineReadiness } from '@/lib/dexie/demo-readiness'
import type { FieldStayDexie } from '@/lib/dexie/schema'

// The readiness gate exists to turn "I think it synced" into an assertion.
// A gate that reports ready when it isn't is worse than no gate at all, so
// the false-green cases are what's covered here.

interface Counts {
  pending?:    number
  failed?:     number
  turnovers?:  number
  properties?: number
  instances?:  number
  items?:      number
  inventory?:  number
  workOrders?: number
  assets?:     number
}

/**
 * Minimal Dexie stand-in. Only the count()/filter() surface the readiness
 * check actually calls is modelled — a real Dexie instance would need a
 * browser IndexedDB, and mocking it wholesale would test the mock.
 */
function fakeDb(c: Counts): FieldStayDexie {
  const table = (n: number) => ({ count: async () => n })
  const mutations = {
    filter: (predicate: (m: { failed?: boolean }) => boolean) => ({
      count: async () => {
        // The check distinguishes pending (failed !== true) from
        // dead-lettered (failed === true); resolve which one is being asked
        // for by running the predicate against a representative row.
        const wantsFailed = predicate({ failed: true })
        return wantsFailed ? (c.failed ?? 0) : (c.pending ?? 0)
      },
    }),
  }

  return {
    mutations,
    turnovers:                table(c.turnovers  ?? 1),
    properties:               table(c.properties ?? 1),
    checklist_instances:      table(c.instances  ?? 1),
    checklist_instance_items: table(c.items      ?? 5),
    inventory_items:          table(c.inventory  ?? 5),
    crew_work_orders:         table(c.workOrders ?? 1),
    property_assets:          table(c.assets     ?? 1),
  } as unknown as FieldStayDexie
}

describe('checkDemoOfflineReadiness', () => {
  it('reports ready when the cache is warm and the outbox is empty', async () => {
    const report = await checkDemoOfflineReadiness(fakeDb({}))
    expect(report.ready).toBe(true)
    expect(report.checks.every((c) => c.ok)).toBe(true)
  })

  it('is NOT ready with pending mutations still queued', async () => {
    const report = await checkDemoOfflineReadiness(fakeDb({ pending: 3 }))
    expect(report.ready).toBe(false)
    const check = report.checks.find((c) => c.label === 'Outbox drained')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('3 unsynced local changes')
  })

  it('is NOT ready with dead-lettered mutations that will never flush', async () => {
    const report = await checkDemoOfflineReadiness(fakeDb({ failed: 1 }))
    expect(report.ready).toBe(false)
    expect(report.checks.find((c) => c.label === 'No dead-lettered writes')?.ok).toBe(false)
  })

  it.each([
    ['Checklist items cached', { items: 0 }],
    ['Inventory items cached', { inventory: 0 }],
    ['Turnovers cached',       { turnovers: 0 }],
    ['Properties cached',      { properties: 0 }],
  ])('is NOT ready when %s is empty', async (label, counts) => {
    const report = await checkDemoOfflineReadiness(fakeDb(counts))
    expect(report.ready).toBe(false)
    expect(report.checks.find((c) => c.label === label)?.ok).toBe(false)
  })

  it('treats empty work orders and assets as informational, not blocking', async () => {
    const report = await checkDemoOfflineReadiness(fakeDb({ workOrders: 0, assets: 0 }))
    expect(report.ready).toBe(true)
    expect(report.checks.find((c) => c.label.startsWith('Work orders'))?.detail).toBeDefined()
    expect(report.checks.find((c) => c.label.startsWith('Assets'))?.detail).toBeDefined()
  })

  it('singularizes the pending-mutation message for exactly one', async () => {
    const report = await checkDemoOfflineReadiness(fakeDb({ pending: 1 }))
    expect(report.checks.find((c) => c.label === 'Outbox drained')?.detail)
      .toContain('1 unsynced local change ')
  })
})
