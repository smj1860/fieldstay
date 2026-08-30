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
 * truth. A cached row absent from the server response is APPENDED only when
 * it is a work order still queued in the outbox (`pendingCreateIds` — a
 * local create the server has never heard of yet); anything else missing
 * from the server response is missing because it is no longer open (the
 * page's own query filters to open statuses, so a completed/cancelled WO
 * server-side simply stops being returned) and must NOT be resurrected from
 * a Dexie cache that has not been told about that transition. Getting this
 * wrong is exactly the bug this file used to have: completing a work order
 * (bulk or single) via a plain Server Action never touches the local cache,
 * so the stale cached "still open" copy would get appended right back onto
 * the board and read as "my status change did nothing" until the next
 * periodic warm reconciled it away, up to 15 minutes later. A row present in
 * both is taken from the SERVER — it is strictly fresher.
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
  pendingCreateIds: Set<string>,
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
  return [
    ...serverRows,
    ...cachedAsRows.filter((r) => !serverIds.has(r.id) && pendingCreateIds.has(r.id)),
  ]
}
