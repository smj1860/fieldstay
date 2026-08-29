import type { WoStatus, WorkOrder } from '@/types/database'

/**
 * Shapes the board actually needs from a raw cached `work_orders` row, plus
 * whatever lookups resolve its property/vendor names.
 *
 * Kept minimal and separate from the board's own (much larger) `WorkOrderRow`
 * so this stays testable without importing a 1400-line client component.
 */
export interface MergeableWorkOrderRow {
  id: string
  property_id: string
  vendor_id: string | null
  status: WoStatus
  properties: { name: string; city: string | null; state: string | null } | null
  vendors: { id: string; name: string; specialty: string | null } | null
}

export interface NameLookup {
  name: string
  city?:  string | null
  state?: string | null
}

export interface VendorLookup {
  id: string
  name: string
  specialty: string | null
}

/**
 * Merges the board's server-rendered work orders with whatever the local
 * cache holds, so an offline-created (or offline-arrived) work order is
 * visible without a sync round-trip and a page refresh — see the header
 * comment in warm-maintenance-board.ts for why this exists.
 *
 * ONLINE: server rows are authoritative — they are this render's actual
 * truth. Cached rows the server doesn't know about yet (a local create still
 * in the outbox, or a warm-pulled row from before the page's own fetch) are
 * APPENDED, never used to replace or reorder what the server said. A row
 * present in both is taken from the SERVER — it is strictly fresher.
 *
 * OFFLINE: the server props are a frozen snapshot from whenever this page was
 * last actually rendered (by React SPA navigation or a service-worker replay
 * of an old cached document) and cannot get any fresher while offline. The
 * cache is refreshed independently by warmMaintenanceBoardForOffline and by
 * every local create, so it is the more current source — it becomes
 * authoritative, and server rows are the fallback for anything the cache
 * hasn't captured (e.g. a device that has never warmed).
 */
export function mergeOfflineWorkOrders<T extends { id: string }>(
  serverRows: T[],
  cachedRows: WorkOrder[],
  isOffline:  boolean,
  propertyLookup: Map<string, NameLookup>,
  vendorLookup:   Map<string, VendorLookup>,
  toRow: (cached: WorkOrder, lookups: { property: NameLookup | null; vendor: VendorLookup | null }) => T,
): T[] {
  const cachedAsRows = cachedRows.map((c) => toRow(c, {
    property: propertyLookup.get(c.property_id) ?? null,
    vendor:   c.vendor_id ? (vendorLookup.get(c.vendor_id) ?? null) : null,
  }))

  if (isOffline) {
    const cachedIds = new Set(cachedAsRows.map((r) => r.id))
    // Anything the server rendered that the cache hasn't captured — a device
    // that has never warmed, or a row from before caching existed — is kept
    // rather than dropped, so going offline never makes the board WORSE than
    // it would have been with no cache at all.
    return [...cachedAsRows, ...serverRows.filter((r) => !cachedIds.has(r.id))]
  }

  const serverIds = new Set(serverRows.map((r) => r.id))
  return [...serverRows, ...cachedAsRows.filter((r) => !serverIds.has(r.id))]
}
