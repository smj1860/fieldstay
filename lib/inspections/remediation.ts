import 'server-only'

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

import { reportQueryError } from '@/lib/supabase/unwrap'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'

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

  // THREE QUERY SHAPES RATHER THAN AN `.or()`, and the reason is not style.
  // PostgREST encodes `.in()` values into the query string, so a combined
  // `or=(a.in.(...),b.in.(...))` puts every failed-item id AND every inspection
  // id in one URL — and an oversized or malformed `.or()` fails the WHOLE read,
  // taking the two roll-ups down with the per-finding lookup. Split, each is
  // independently bounded and independently survivable.
  //
  // Each shape is further CHUNKED (IN_CLAUSE_CHUNK_SIZE ids per `.in()`) rather
  // than run as one query with an inflated `.limit(ids.length * 3)` — the same
  // reasoning as PostgREST's `.or()` above applies to `.in()` itself: it is also
  // encoded into the URL query string, so an id list sized by "how many failures
  // /walks are in scope" (thousands, at real scale) risks a request that exceeds
  // reverse-proxy request-line limits outright rather than degrading. A chunk
  // that errors is reported and skipped independently — see fetchChunkedRows.
  //
  // The per-item list is the only one that scales with data rather than with
  // the caller's cap, and it is bounded by failures across the walks in scope.
  // .order('created_at', { ascending: false }) + a *3 headroom limit per chunk,
  // not an exact 1:1 bet: the "one row per key" assumption below (a cancelled WO
  // replaced by a new one, a retried request racing a unique constraint, a
  // manually duplicated PO) can be violated, and without an ORDER BY Postgres
  // is free to return the surviving rows in whatever order it finds
  // convenient — not necessarily creation order. Newest-first plus
  // indexWorkOrders/indexPurchaseOrders keeping only the FIRST row seen per
  // key (below) makes "newest wins" deterministic instead of an array-order
  // coin flip.
  const [byItemRows, byInspectionRows, poRows] = await Promise.all([
    fetchChunkedRows<WoRow>(failedItemIds, `${site}.workOrders`, orgId, (chunk) => supabase
      .from('work_orders')
      .select('wo_number, status, source_inspection_item_id, source_inspection_id, created_at')
      .eq('org_id', orgId)
      .in('source_inspection_item_id', chunk)
      .order('created_at', { ascending: false })
      .limit(chunk.length * 3)),
    fetchChunkedRows<WoRow>(inspectionIds, `${site}.rollups`, orgId, (chunk) => supabase
      .from('work_orders')
      .select('wo_number, status, source_inspection_item_id, source_inspection_id, created_at')
      .eq('org_id', orgId)
      .in('source_inspection_id', chunk)
      .order('created_at', { ascending: false })
      .limit(chunk.length * 3)),
    fetchChunkedRows<PoRow>(inspectionIds, `${site}.purchaseOrders`, orgId, (chunk) => supabase
      .from('purchase_orders')
      .select('id, status, source_inspection_id, created_at')
      .eq('org_id', orgId)
      .in('source_inspection_id', chunk)
      .order('created_at', { ascending: false })
      .limit(chunk.length * 3)),
  ])

  indexWorkOrders(index, byItemRows)
  indexWorkOrders(index, byInspectionRows)
  indexPurchaseOrders(index, poRows)

  return index
}

/**
 * Runs one `.in()` query per chunk of `ids` (IN_CLAUSE_CHUNK_SIZE per chunk)
 * and merges the rows, rather than one query sized by the whole list.
 *
 * A chunk that errors is reported and its rows dropped, independently of every
 * other chunk — one bad chunk costs part of this section of the index, never
 * the whole thing, matching this module's "never throws" contract above.
 *
 * `ids.length === 0` short-circuits before building any chunk: `.in()` with an
 * empty list is a PostgREST syntax error rather than a match-nothing.
 */
async function fetchChunkedRows<Row>(
  ids:  readonly string[],
  site: string,
  orgId: string,
  runChunk: (chunk: readonly string[]) => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
): Promise<Row[]> {
  if (ids.length === 0) return []

  const results = await Promise.all(chunkArray(ids, IN_CLAUSE_CHUNK_SIZE).map(runChunk))

  const rows: Row[] = []
  for (const res of results) {
    if (reportQueryError(res.error, { site, orgId })) continue
    rows.push(...(res.data ?? []))
  }
  return rows
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
    // Rows arrive newest-first (see the query above) — keep only the FIRST
    // one seen per key so a stale/cancelled duplicate can never overwrite an
    // already-indexed newer row.
    if (wo.source_inspection_item_id) {
      if (!index.byItem.has(wo.source_inspection_item_id)) index.byItem.set(wo.source_inspection_item_id, entry)
    } else if (wo.source_inspection_id) {
      if (!index.byInspection.has(wo.source_inspection_id)) index.byInspection.set(wo.source_inspection_id, entry)
    }
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
