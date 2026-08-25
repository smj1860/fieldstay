import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { reportQueryError } from '@/lib/supabase/unwrap'

// What each inspection failure turned into, and where that record stands NOW.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS SHARED RATHER THAN IMPLEMENTED PER SURFACE
//
// Two surfaces answer this question — the owner portal's history section and
// the exported report — and §"The one place immutability is subtle" is explicit
// that they must agree:
//
//   "The finding is immutable; the remediation status is not. […] two PDF
//    exports of the same inspection can differ in the remediation column.
//    Correct behaviour, but exports carry a generated-at stamp so the
//    difference is explainable rather than suspicious."
//
// A difference between two exports taken a week apart is explainable. A
// difference between the portal and the PDF taken the same minute is not, and
// that is exactly what two implementations of the three-key lookup below would
// eventually produce.

export type RemediationStatus =
  | { kind: 'work_order';     reference: string | null; status: string }
  | { kind: 'purchase_order'; reference: string | null; status: string }
  | { kind: 'none' }

export interface RemediationIndex {
  /** Per-finding work orders, keyed on the item they came from. */
  byItem:       Map<string, RemediationStatus>
  /** The ONE cleaning work order / purchase order per inspection. */
  byInspection: Map<string, RemediationStatus>
}

/** The status for one finding, falling back to its walk's roll-up, then to none. */
export function remediationFor(
  index:        RemediationIndex,
  itemId:       string,
  inspectionId: string,
): RemediationStatus {
  return index.byItem.get(itemId)
    ?? index.byInspection.get(inspectionId)
    ?? { kind: 'none' }
}

export const EMPTY_REMEDIATION: RemediationIndex = { byItem: new Map(), byInspection: new Map() }

/**
 * What each failure turned into, and where that record stands now.
 *
 * THREE KEYS, BECAUSE REMEDIATION HAS THREE SHAPES (§6): a work order per
 * failure keyed on `source_inspection_item_id`; ONE cleaning work order for the
 * whole walk keyed on `source_inspection_id`; and ONE purchase order for the
 * whole walk, also keyed on `source_inspection_id`. A per-item lookup would
 * miss the two roll-ups entirely and show "no action taken" against a finding
 * that is on somebody's list.
 *
 * Three bounded queries, not one per finding.
 *
 * NEVER THROWS. Each of the three is reported and skipped independently, so the
 * worst case is one section of the index missing rather than the caller losing
 * the whole document. Both callers render something an owner is waiting on.
 */
export async function loadRemediationIndex(
  supabase:      SupabaseClient,
  orgId:         string,
  failedItemIds: string[],
  inspectionIds: string[],
  site:          string,
): Promise<RemediationIndex> {
  const index: RemediationIndex = { byItem: new Map(), byInspection: new Map() }
  if (inspectionIds.length === 0) return index

  // THREE QUERIES RATHER THAN AN `.or()`, and the reason is not style.
  // PostgREST encodes `.in()` values into the query string, so a combined
  // `or=(a.in.(...),b.in.(...))` puts every failed-item id AND every inspection
  // id in one URL — and an oversized or malformed `.or()` fails the WHOLE read,
  // taking the two roll-ups down with the per-finding lookup. Split, each is
  // independently bounded and independently survivable.
  //
  // The per-item list is the only one that scales with data rather than with
  // the caller's cap, and it is bounded by failures across the walks in scope.
  const [byItemRes, byInspectionRes, poRes] = await Promise.all([
    failedItemIds.length === 0 ? emptyWoResult() : supabase
      .from('work_orders')
      .select('wo_number, status, source_inspection_item_id, source_inspection_id')
      .eq('org_id', orgId)
      .in('source_inspection_item_id', failedItemIds)
      .limit(failedItemIds.length),
    supabase
      .from('work_orders')
      .select('wo_number, status, source_inspection_item_id, source_inspection_id')
      .eq('org_id', orgId)
      .in('source_inspection_id', inspectionIds)
      .limit(inspectionIds.length),
    supabase
      .from('purchase_orders')
      .select('id, status, source_inspection_id')
      .eq('org_id', orgId)
      .in('source_inspection_id', inspectionIds)
      .limit(inspectionIds.length),
  ])

  if (!reportQueryError(byItemRes.error, { site: `${site}.workOrders`, orgId })) {
    indexWorkOrders(index, (byItemRes.data ?? []) as WoRow[])
  }
  if (!reportQueryError(byInspectionRes.error, { site: `${site}.rollups`, orgId })) {
    indexWorkOrders(index, (byInspectionRes.data ?? []) as WoRow[])
  }
  if (!reportQueryError(poRes.error, { site: `${site}.purchaseOrders`, orgId })) {
    indexPurchaseOrders(index, (poRes.data ?? []) as PoRow[])
  }

  return index
}

/** A walk with zero failures needs no per-item lookup — and `in.()` with an
 *  empty list is a PostgREST syntax error rather than a match-nothing. */
function emptyWoResult() {
  return Promise.resolve({ data: [] as WoRow[], error: null })
}

/**
 * A work order lands under its ITEM when it came from one finding, and under
 * its INSPECTION when it is the cleaning roll-up covering many (§5). The two
 * keys are mutually exclusive by construction — only the roll-up sets
 * `source_inspection_id`, which is why its unique index can be a plain partial
 * one — so the `else` is a statement about the schema, not a preference.
 */
function indexWorkOrders(index: RemediationIndex, rows: WoRow[]): void {
  for (const wo of rows) {
    const entry = { kind: 'work_order' as const, reference: wo.wo_number, status: wo.status }
    if (wo.source_inspection_item_id) index.byItem.set(wo.source_inspection_item_id, entry)
    else if (wo.source_inspection_id) index.byInspection.set(wo.source_inspection_id, entry)
  }
}

/**
 * Purchase orders fill in only where no work order already claimed the
 * inspection. A cleaning roll-up is the more specific answer for a finding, and
 * a reader seeing two conflicting statuses against one line learns nothing.
 */
function indexPurchaseOrders(index: RemediationIndex, rows: PoRow[]): void {
  for (const po of rows) {
    if (!po.source_inspection_id) continue
    if (index.byInspection.has(po.source_inspection_id)) continue
    index.byInspection.set(po.source_inspection_id, {
      kind: 'purchase_order', reference: null, status: po.status,
    })
  }
}

interface WoRow {
  wo_number: string | null
  status:    string
  source_inspection_item_id: string | null
  source_inspection_id:      string | null
}

interface PoRow {
  id:     string
  status: string
  source_inspection_id: string | null
}
