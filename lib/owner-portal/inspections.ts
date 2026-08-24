import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { reportQueryError } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { parseFormSnapshot } from '@/lib/inspections/snapshots'

// The inspection history an owner sees.
//
// §2: "Posts the day it is completed, failures included, with the WO/PO shown
// alongside." §9 adds "each with its linked WO/PO and that record's CURRENT
// status" — the status matters more than the link, because an owner reading
// "loose handrail" wants to know it is being dealt with, and a link to a work
// order without its state answers the first half of that.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMPLETED ONLY, AND NO WAY TO HIDE ONE
//
// A walk in progress is not a record; half a form shown to an owner is worse
// than nothing. And unlike `owner_transactions.visible_to_owner` there is
// deliberately no per-inspection toggle: §1 is that the record is evidence for
// an insurance discount, and "a complete record shows the gaps too". A history
// a PM can curate is not evidence of anything. If that is ever wanted it is a
// product decision to argue explicitly, not a column to quietly add.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ROLLING HISTORY, NOT THE SELECTED MONTH
//
// Every other section of this portal is scoped to the month picker, and this
// one deliberately is not. §1: "A single audit earns nothing. Three years of
// consistent quarterly safety inspections is the artifact." A month view shows
// at most one walk and hides the continuity that IS the artifact. The section
// says so in its own subtitle rather than leaving an owner to wonder why the
// month picker does not move it.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO PHOTOS IN THIS VERSION
//
// Inspection photos live in a PRIVATE bucket and reaching them from a
// token-authenticated page means minting signed URLs for an unauthenticated
// caller — a real surface that deserves its own change rather than being folded
// into a first cut. The finding text and the remediation status are the
// substance; a photo is corroboration.

/**
 * How many completed walks the page renders.
 *
 * A cap is unavoidable — a three-property owner three years in has ~100 walks,
 * and neither the query nor the page should grow without bound. What matters is
 * that the cap is STATED. §1 calls the multi-year record the artifact, so a
 * history that silently stops partway through 2024 reads as the PM having given
 * up rather than as a page limit. `loadOwnerInspections` therefore returns the
 * total alongside the rows and the section says "showing the most recent 24 of
 * 106" when the two differ.
 */
const MAX_INSPECTIONS = 24

/**
 * Ceiling on the item drain, sized against the real forms.
 *
 * The seeded forms are 53–60 items each and repeat-per-asset items push a
 * single walk higher, so 24 inspections is ~1,500 item rows — ALREADY past
 * PostgREST's 1,000-row `max_rows` cap, which truncates with a 200 and no
 * signal. That is why the item read paginates rather than carrying a `.limit()`:
 * a `.limit()` above `max_rows` does not raise the cap, it just makes the
 * truncation harder to notice. 6,000 is four pages and well clear of any real
 * walk.
 */
const MAX_ITEM_ROWS = 6_000

export type RemediationStatus =
  | { kind: 'work_order';    reference: string | null; status: string }
  | { kind: 'purchase_order'; reference: string | null; status: string }
  | { kind: 'none' }

export interface OwnerInspectionFinding {
  id:       string
  prompt:   string
  /** The inspector's failure description. Becomes the work order title (§5). */
  note:     string | null
  remediation: RemediationStatus
}

export interface OwnerInspectionHistory {
  /** Most recent first, capped at `MAX_INSPECTIONS`. */
  inspections: OwnerInspection[]
  /** Every completed walk in scope, capped or not — so the page can say so. */
  totalCompleted: number
}

export interface OwnerInspection {
  id:          string
  propertyId:  string
  completedAt: string
  /** From the SNAPSHOT — §11.6 requires the version a walk used to be shown. */
  formLabel:   string
  formVersion: number
  inspectorName: string | null
  passCount:   number
  findings:    OwnerInspectionFinding[]
}

const FORM_LABELS: Record<string, string> = {
  safety:  'Safety & Risk Mitigation',
  indoor:  'Indoor Property & Inventory',
  outdoor: 'Outdoor Property & Grounds',
}

/**
 * Completed inspections for the properties this token authorizes.
 *
 * `propertyIds` is `txnPropertyIds` from the caller — token-derived, never a
 * query parameter. That is the tenant boundary for this whole route and the
 * only thing standing between one owner and a sibling owner's properties, so it
 * is a required argument rather than something resolved in here.
 *
 * Returns an empty history on ANY read failure rather than throwing. A portal
 * that 500s because one section could not load is worse for the owner than a
 * portal missing that section — but the failure is reported, so it is not
 * silent to us.
 */
export async function loadOwnerInspections(
  supabase:    SupabaseClient,
  orgId:       string,
  propertyIds: string[],
): Promise<OwnerInspectionHistory> {
  if (propertyIds.length === 0) return EMPTY_HISTORY

  // `count: 'exact'` is what makes the cap honest. Without the total there is no
  // way to distinguish "this is the whole record" from "this is the first page
  // of it", and the page would present the second as the first.
  const inspectionsRes = await supabase
    .from('inspections')
    .select('id, property_id, completed_at, form_version, form_snapshot, inspector_name', { count: 'exact' })
    .eq('org_id', orgId)
    .in('property_id', propertyIds)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(MAX_INSPECTIONS)

  if (reportQueryError(inspectionsRes.error, { site: 'owner-portal.inspections', orgId })) {
    return EMPTY_HISTORY
  }

  const rows = (inspectionsRes.data ?? []) as InspectionRow[]
  if (rows.length === 0) return EMPTY_HISTORY

  const items = await loadItems(supabase, orgId, rows.map((r) => r.id))
  const remediation = await loadRemediation(
    supabase, orgId,
    items.filter((i) => i.result === 'fail').map((i) => i.id),
    rows.map((r) => r.id),
  )

  return {
    inspections: rows.map((row) => buildInspection(row, items, remediation)),
    // `count` is null when the driver did not return one (an older PostgREST, a
    // test double). Falling back to the page length says "nothing was hidden",
    // which is the claim that degrades gracefully — the alternative is a
    // "showing 24 of 0" banner.
    totalCompleted: inspectionsRes.count ?? rows.length,
  }
}

const EMPTY_HISTORY: OwnerInspectionHistory = { inspections: [], totalCompleted: 0 }

interface InspectionRow {
  id:             string
  property_id:    string
  completed_at:   string
  form_version:   number
  form_snapshot:  unknown
  inspector_name: string | null
}

interface ItemRow {
  id:            string
  inspection_id: string
  prompt_snapshot: string
  note:          string | null
  result:        string | null
}

function buildInspection(
  row:         InspectionRow,
  items:       ItemRow[],
  remediation: RemediationIndex,
): OwnerInspection {
  const mine   = items.filter((i) => i.inspection_id === row.id)
  const failed = mine.filter((i) => i.result === 'fail')

  return {
    id:          row.id,
    propertyId:  row.property_id,
    completedAt: row.completed_at,
    formLabel:   formLabelOf(row.form_snapshot),
    formVersion: row.form_version,
    inspectorName: row.inspector_name,
    // PASSES, not "total minus failures": an item answered N/A is neither, and
    // counting it as a pass would overstate the walk.
    passCount:   mine.filter((i) => i.result === 'pass').length,
    findings:    failed.map((item) => ({
      id:     item.id,
      prompt: item.prompt_snapshot,
      note:   item.note,
      remediation: remediation.byItem.get(item.id)
        ?? remediation.byInspection.get(row.id)
        ?? { kind: 'none' as const },
    })),
  }
}

/**
 * The form's identity from its SNAPSHOT, never from a join to the live form.
 *
 * §11.6: the version is shown precisely so a three-year history that used two
 * versions does not read as inconsistent inspecting. Reading the label off the
 * current form would undo that on the very next re-seed.
 */
function formLabelOf(snapshot: unknown): string {
  const parsed = parseFormSnapshot(snapshot)
  if (!parsed) return 'Inspection'
  return FORM_LABELS[parsed.form_key] ?? parsed.form_key
}

/**
 * Every answered item across the shown walks — PAGINATED, not `.limit()`ed.
 *
 * The seeded forms are 53–60 items apiece, so 24 walks is ~1,500 rows against
 * PostgREST's 1,000-row `max_rows` cap. A `.limit(4800)` does not raise that
 * cap; it returns the first 1,000 with a 200 and no truncation signal, and the
 * visible symptom would have been the OLDEST walks rendering as "0 checks
 * passed, no findings" — a clean-looking inspection that never happened.
 *
 * `.order('id')` is load-bearing: `.range()` page boundaries are only stable
 * under a stable sort.
 */
async function loadItems(
  supabase:      SupabaseClient,
  orgId:         string,
  inspectionIds: string[],
): Promise<ItemRow[]> {
  try {
    return await fetchAllRows<ItemRow>(
      (from, to) => supabase
        .from('inspection_items')
        .select('id, inspection_id, prompt_snapshot, note, result')
        .eq('org_id', orgId)
        .in('inspection_id', inspectionIds)
        .order('id', { ascending: true })
        .range(from, to),
      { maxRows: MAX_ITEM_ROWS, label: 'owner-portal.inspectionItems' },
    )
  } catch (err) {
    // Same posture as every other read here: report it, then render the portal
    // without this section rather than 500ing the owner's whole page.
    reportError(err, { site: 'owner-portal.inspectionItems', orgId })
    return []
  }
}

interface RemediationIndex {
  /** Per-finding work orders, keyed on the item they came from. */
  byItem:       Map<string, RemediationStatus>
  /** The ONE cleaning work order / purchase order per inspection. */
  byInspection: Map<string, RemediationStatus>
}

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
 */
async function loadRemediation(
  supabase:      SupabaseClient,
  orgId:         string,
  failedItemIds: string[],
  inspectionIds: string[],
): Promise<RemediationIndex> {
  const index: RemediationIndex = { byItem: new Map(), byInspection: new Map() }

  // THREE QUERIES RATHER THAN AN `.or()`, and the reason is not style.
  // PostgREST encodes `.in()` values into the query string, so a combined
  // `or=(a.in.(...),b.in.(...))` puts every failed-item id AND every inspection
  // id in one URL — and an oversized or malformed `.or()` fails the WHOLE read,
  // taking the two roll-ups down with the per-finding lookup. Split, each is
  // independently bounded and independently survivable: the worst case is one
  // section of the remediation index missing, not all three.
  //
  // The per-item list is the only one that scales with data rather than with
  // MAX_INSPECTIONS, and it is bounded by failures across 24 walks — the ~100
  // uuids that would take is well inside every gateway limit.
  const [byItemRes, byInspectionRes, poRes] = await Promise.all([
    failedItemIds.length === 0 ? EMPTY_RESULT : supabase
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

  if (!reportQueryError(byItemRes.error, { site: 'owner-portal.inspectionWorkOrders', orgId })) {
    indexWorkOrders(index, (byItemRes.data ?? []) as WoRow[])
  }
  if (!reportQueryError(byInspectionRes.error, { site: 'owner-portal.inspectionRollups', orgId })) {
    indexWorkOrders(index, (byInspectionRes.data ?? []) as WoRow[])
  }
  if (!reportQueryError(poRes.error, { site: 'owner-portal.inspectionPurchaseOrders', orgId })) {
    indexPurchaseOrders(index, (poRes.data ?? []) as PoRow[])
  }

  return index
}

/** A walk with zero failures needs no per-item lookup — and `in.()` with an
 *  empty list is a PostgREST syntax error rather than a match-nothing. */
const EMPTY_RESULT = Promise.resolve({ data: [] as WoRow[], error: null })

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
 * an owner reading two conflicting statuses against one line learns nothing.
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
