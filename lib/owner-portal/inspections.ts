import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { reportQueryError } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { parseFormSnapshot, recordOnlyItemIds } from '@/lib/inspections/snapshots'
import {
  loadRemediationIndex,
  remediationFor,
  type RemediationIndex,
  type RemediationStatus,
} from '@/lib/inspections/remediation'

export type { RemediationStatus }

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
  const remediation = await loadRemediationIndex(
    supabase, orgId,
    items.filter((i) => i.result === 'fail').map((i) => i.id),
    rows.map((r) => r.id),
    'owner-portal.inspections',
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
  /** Joins the answer back to its definition, which is where `remediation` lives. */
  form_item_id:  string
  prompt_snapshot: string
  note:          string | null
  result:        string | null
}

function buildInspection(
  row:         InspectionRow,
  items:       ItemRow[],
  remediation: RemediationIndex,
): OwnerInspection {
  const snapshot   = parseFormSnapshot(row.form_snapshot)
  const recordOnly = recordOnlyItemIds(snapshot)

  // RECORD-ONLY ITEMS ARE NOT CHECKS, so they leave both numbers below. See
  // recordOnlyItemIds in lib/inspections/snapshots.ts for what they are.
  //
  // The PORTAL DROPS THEM ENTIRELY, and this is the one place it deliberately
  // differs from the exported report, which prints them under their own
  // "Recorded facts" heading. A PDF is the evidentiary artifact and "no alarm
  // system present" belongs on it; the portal is a summary an owner reads on a
  // phone, where the same line reads as a complaint.
  //
  // They leave the PASS COUNT as well, and that half is easy to miss. Filtering
  // only the findings would mean a property WITH an alarm scored +1 while one
  // without scored nothing — a silent bias in a number owners read as "how did
  // my property do". A count captioned "checks passed" should count checks.
  const mine   = items.filter((i) => i.inspection_id === row.id && !recordOnly.has(i.form_item_id))
  const failed = mine.filter((i) => i.result === 'fail')

  return {
    id:          row.id,
    propertyId:  row.property_id,
    completedAt: row.completed_at,
    formLabel:   formLabelOf(snapshot),
    formVersion: row.form_version,
    inspectorName: row.inspector_name,
    // PASSES, not "total minus failures": an item answered N/A is neither, and
    // counting it as a pass would overstate the walk.
    passCount:   mine.filter((i) => i.result === 'pass').length,
    findings:    failed.map((item) => ({
      id:     item.id,
      prompt: item.prompt_snapshot,
      note:   item.note,
      remediation: remediationFor(remediation, item.id, row.id),
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
function formLabelOf(parsed: ReturnType<typeof parseFormSnapshot>): string {
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
        .select('id, inspection_id, form_item_id, prompt_snapshot, note, result')
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
