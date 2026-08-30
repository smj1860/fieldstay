import { describe, it, expect } from 'vitest'

import { mergeOfflineWorkOrders, type NameLookup, type VendorLookup } from '@/app/(dashboard)/maintenance/merge-offline-work-orders'
import type { WorkOrder } from '@/types/database'

// ============================================================================
// Pure merge logic, tested without mounting the 1400-line board component it
// feeds. See merge-offline-work-orders.ts for the ONLINE/OFFLINE rules this
// pins: online, cached rows are additive only; offline, the cache becomes
// authoritative and server props are the fallback.
// ============================================================================

interface Row { id: string; source: 'server' | 'cached' }

const cached = (id: string): WorkOrder => ({ id, property_id: 'p1', vendor_id: null } as WorkOrder)
const toRow = (c: WorkOrder): Row => ({ id: c.id, source: 'cached' })

const propertyLookup = new Map<string, NameLookup>()
const vendorLookup   = new Map<string, VendorLookup>()

const noPending = new Set<string>()

describe('mergeOfflineWorkOrders — online', () => {
  it('is the server rows, unchanged, when the cache has nothing new', () => {
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(server, [], false, noPending, propertyLookup, vendorLookup, toRow)
    expect(result).toEqual(server)
  })

  it('appends a cached row still queued as a pending local create', () => {
    // The concrete bug this preserves: a work order created offline, still in the outbox.
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(
      server, [cached('local-1')], false, new Set(['local-1']), propertyLookup, vendorLookup, toRow,
    )

    expect(result.map((r) => r.id)).toEqual(['a', 'local-1'])
  })

  it('drops a cached row the server no longer lists when it is not a pending create', () => {
    // The concrete bug this fixes: a work order completed via a plain Server
    // Action (bulk or single) never touches the local cache. The server's
    // open-status query correctly stops returning it, and the stale cached
    // copy — still sitting in Dexie with its old open status — must not be
    // resurrected onto the board as if the completion never happened.
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(
      server, [cached('completed-elsewhere')], false, noPending, propertyLookup, vendorLookup, toRow,
    )

    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('never lets a cached row override or duplicate a server row with the same id', () => {
    // The server is strictly fresher — a stale cached copy of a row the
    // server already returned must not shadow or duplicate it.
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(server, [cached('a')], false, noPending, propertyLookup, vendorLookup, toRow)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 'a', source: 'server' })
  })
})

describe('mergeOfflineWorkOrders — offline', () => {
  it('renders from the cache instead of the (frozen, unreachable) server props', () => {
    const server: Row[] = [{ id: 'stale-server-only', source: 'server' }]
    const result = mergeOfflineWorkOrders(server, [cached('a'), cached('b')], true, noPending, propertyLookup, vendorLookup, toRow)

    expect(result.map((r) => r.id).sort()).toEqual(['a', 'b', 'stale-server-only'])
  })

  it('a device that has never warmed still shows the last server render', () => {
    // Going offline must never make the board WORSE than having no cache at
    // all — an empty cache falls back to whatever props already exist.
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(server, [], true, noPending, propertyLookup, vendorLookup, toRow)

    expect(result).toEqual(server)
  })

  it('a row present in both is taken from the cache, not duplicated', () => {
    const server: Row[] = [{ id: 'a', source: 'server' }]
    const result = mergeOfflineWorkOrders(server, [cached('a')], true, noPending, propertyLookup, vendorLookup, toRow)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 'a', source: 'cached' })
  })
})

describe('mergeOfflineWorkOrders — lookups reach the row builder', () => {
  it('resolves property and vendor names for a cached row', () => {
    const properties = new Map<string, NameLookup>([['p1', { name: 'Lake House', city: 'Alex City', state: 'AL' }]])
    const vendors     = new Map<string, VendorLookup>([['v1', { id: 'v1', name: 'Ace Plumbing', specialty: 'plumbing' }]])
    const wo = { id: 'a', property_id: 'p1', vendor_id: 'v1' } as WorkOrder

    let seenProperty: NameLookup | null = null
    let seenVendor:   VendorLookup | null = null

    mergeOfflineWorkOrders([], [wo], false, noPending, properties, vendors, (_c, lookups) => {
      seenProperty = lookups.property
      seenVendor   = lookups.vendor
      return { id: 'a', source: 'cached' as const }
    })

    expect(seenProperty).toEqual({ name: 'Lake House', city: 'Alex City', state: 'AL' })
    expect(seenVendor).toEqual({ id: 'v1', name: 'Ace Plumbing', specialty: 'plumbing' })
  })

  it('a work order with no vendor assigned resolves to null, not a lookup miss', () => {
    const wo = { id: 'a', property_id: 'p1', vendor_id: null } as WorkOrder
    let seenVendor: VendorLookup | null | undefined

    mergeOfflineWorkOrders([], [wo], false, noPending, propertyLookup, vendorLookup, (_c, lookups) => {
      seenVendor = lookups.vendor
      return { id: 'a', source: 'cached' as const }
    })

    expect(seenVendor).toBeNull()
  })
})
