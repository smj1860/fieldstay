import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchAllRows } from '@/lib/inngest/paginate'
import { unwrap, unwrapList, type PostgrestResult } from '@/lib/supabase/unwrap'
import {
  parseFormSnapshot,
  recordOnlyItemIds,
  type FormSnapshot,
  type HeaderSnapshot,
} from '@/lib/inspections/snapshots'
import {
  loadRemediationIndex,
  remediationFor,
  type RemediationStatus,
} from '@/lib/inspections/remediation'
import type { InspectionAction } from '@/types/database'

// The data model behind an exported inspection report, for BOTH audiences.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE BODY, TWO AUDIENCES, AND THE DIFFERENCE IS PHOTOS ONLY
//
// @smj1860, 2026-08-25: "both owner and pm can download the report itself. the
// photos only the pm and he/she can share with the owner if wanted."
//
// So the body — letterhead, every answer, findings, remediation status, the
// sign-off block — is byte-for-byte the same document whoever asked for it. If
// it were not, an owner and a PM comparing their copies would find two versions
// of a record whose entire value is that it is not adjusted after the fact.
//
// ─────────────────────────────────────────────────────────────────────────────
// `includePhotos` IS A LOAD PARAMETER, NOT A RENDER ONE
//
// The tempting shape is to load everything and let the renderer decide. That
// puts the private bucket one renderer bug away from an unauthenticated
// token-holder, and the bug would be invisible — a PDF with an extra page in it
// looks like a PDF with an extra page in it.
//
// Instead the owner path never fetches a photo at all: no signed URL is minted,
// no object is downloaded, and `photo` is absent from every answer it returns.
// The renderer cannot draw what it was not given. The two decisions — who may
// ask, and what is fetched — then sit in the same place rather than one route
// trusting a flag it passed to something else.
//
// ─────────────────────────────────────────────────────────────────────────────
// RECORD-ONLY ITEMS ARE PRINTED, UNLIKE IN THE PORTAL
//
// lib/owner-portal/inspections.ts drops them; this keeps them, under their own
// heading, flagged `isRecordOnly`. A PDF is the evidentiary artifact and "no
// alarm system present" is exactly the kind of fact an insurer asks about. What
// they must not do is count as findings or as passed checks, which is the same
// rule both surfaces follow.

/** A single answered item, as it goes on the page. */
export interface ReportAnswer {
  id:     string
  prompt: string
  /** `pass` | `fail` | `na` for a yes_no item; null for count/text/date/photo. */
  result: string | null
  /** The typed answer for a non-yes_no item, already rendered to a string. */
  value:  string | null
  /** The failure description. Becomes the work order title (§5). */
  note:   string | null
  naReason: string | null
  actions:  InspectionAction[]
  needsCleaning: boolean
  /** Fact-recording items ("trampoline present"): neither a check nor a finding. */
  isRecordOnly: boolean
  /** Present only where the caller asked for photos AND the object resolved. */
  photo: ReportPhoto | null
  /** The only way past a photo_required item — printed so a gap is explained. */
  photoUnavailableReason: string | null
  /** Live join, not history — see lib/inspections/remediation.ts. */
  remediation: RemediationStatus
}

export interface ReportPhoto {
  /** The storage object key, printed in the photo log so a page maps to a file. */
  path:  string
  bytes: Uint8Array
  /** pdf-lib embeds JPEG and PNG only; anything else is listed, not drawn. */
  format: 'jpeg' | 'png' | 'unsupported'
}

export interface ReportSection {
  key:   string
  name:  string
  answers: ReportAnswer[]
}

export interface ReportInspection {
  id:          string
  propertyId:  string
  formKey:     string
  formLabel:   string
  formVersion: number
  header:      HeaderSnapshot | null
  /**
   * The date the report prints in the sign-off block (§12.1).
   *
   * `source` is carried rather than dropped because §8 records that a walk can
   * be STARTED OFFLINE, in which case `started_at` is a device clock corrected
   * by measured skew — not a server stamp. The spec's phase-7 row says
   * "server-stamped, never typed", which is true of the two alternatives it was
   * ruling out and NOT true of every row. Printing a device-timed start as
   * though it were server-timed launders the weaker claim, which is the same
   * mistake ConditionsSnapshot's `recorded`/`reported` split exists to prevent.
   */
  startedAt:       string
  startedAtSource: 'server' | 'device'
  completedAt:     string
  inspectorName:   string | null
  sections:  ReportSection[]
  /** Answered checks that passed. Record-only items are excluded (see above). */
  passCount: number
  /** Answered checks that failed. Record-only items are excluded. */
  failCount: number
}

export interface InspectionReport {
  orgId:        string
  propertyName: string
  /** ISO. Printed on every page — see §"The one place immutability is subtle". */
  generatedAt:  string
  inspections:  ReportInspection[]
  /** True when the caller asked for photos, whether or not any resolved. */
  photosIncluded: boolean
  /** Set when a whole-property history was capped, so the PDF can say so. */
  omittedCount: number
}

const FORM_LABELS: Record<string, string> = {
  safety:  'Safety & Risk Mitigation',
  indoor:  'Indoor Property & Inventory',
  outdoor: 'Outdoor Property & Grounds',
}

/**
 * Ceiling on a whole-property history export.
 *
 * Everything after the load is synchronous CPU on the request path — pdf-lib
 * draw calls per answer, then one `save()` that serialises the document — with
 * no yield point, exactly as the CPA export's comment describes. At three
 * inspections a year a property reaches 60 walks in twenty years, so this is
 * far above any real portfolio while still turning the pathological case into a
 * stated cap rather than a request killed mid-serialisation.
 *
 * The cap is REPORTED, not silent: `omittedCount` goes on the cover page.
 */
export const MAX_HISTORY_INSPECTIONS = 60

/**
 * Ceiling on the answer drain.
 *
 * The seeded forms are 53–60 items each and repeat-per-asset items push a
 * single walk higher, so a 60-walk history is ~4,000 rows — well past
 * PostgREST's 1,000-row `max_rows` cap, which truncates with a 200 and no
 * signal. Hence `fetchAllRows` rather than a `.limit()`: a `.limit()` above
 * `max_rows` does not raise the cap, it only makes the truncation harder to
 * see, and here the visible symptom would be an evidentiary document quietly
 * missing its oldest walks' answers.
 */
const MAX_ANSWER_ROWS = 12_000

/**
 * Ceiling on photos embedded in one report, and it is about bytes not rows.
 *
 * The bucket caps an object at 10MB, so an unbounded photo log on a long
 * history could try to hold ~600MB in memory and serialise it into one
 * response. 150 covers a full Safety walk's photos many times over.
 */
export const MAX_REPORT_PHOTOS = 150

export interface LoadReportInput {
  orgId: string
  /** Exactly one of these. `propertyId` is the whole-history export. */
  inspectionId?: string
  propertyId?:   string
  /**
   * Fetch photo bytes. PM-authenticated callers only — see the header comment.
   * The owner route passes `false` and no object is ever read.
   */
  includePhotos: boolean
  /** Injected so a test can assert the stamp rather than race the clock. */
  now?: string
}

/**
 * Builds the report for one inspection or one property's whole history.
 *
 * THROWS on a read failure, unlike `loadOwnerInspections`. The portal degrades
 * to a missing section because a 500 for one section is worse than the page;
 * a download has no such fallback — a PDF silently missing half its answers is
 * indistinguishable from a walk where half the items were skipped, and that is
 * the one thing this document exists to be trusted about.
 */
export async function loadInspectionReport(
  supabase: SupabaseClient,
  input:    LoadReportInput,
): Promise<InspectionReport | null> {
  const { orgId, includePhotos } = input

  const { rows, totalCompleted } = await loadInspectionRows(supabase, input)
  if (rows.length === 0) return null

  const answers = await loadAnswers(supabase, orgId, rows.map((r) => r.id))

  // Record-only ids are per-inspection, because each walk carries its OWN
  // snapshot: an item reclassified between two walks must read as it was
  // classified in each. A single merged set would let the newer walk's
  // classification rewrite the older walk's report.
  const snapshots  = new Map(rows.map((r) => [r.id, parseFormSnapshot(r.form_snapshot)]))
  const recordOnly = new Map(
    rows.map((r) => [r.id, recordOnlyItemIds(snapshots.get(r.id) ?? null)]),
  )

  const failedIds = answers
    .filter((a) => a.result === 'fail' && !recordOnly.get(a.inspection_id)?.has(a.form_item_id))
    .map((a) => a.id)

  const remediation = await loadRemediationIndex(
    supabase, orgId, failedIds, rows.map((r) => r.id), 'inspections.report',
  )

  const photos = includePhotos
    ? await loadPhotos(supabase, answers)
    : new Map<string, ReportPhoto>()

  return {
    orgId,
    propertyName: propertyNameOf(rows[0]!),
    generatedAt:  input.now ?? new Date().toISOString(),
    photosIncluded: includePhotos,
    omittedCount: Math.max(0, totalCompleted - rows.length),
    inspections: rows.map((row) => buildInspection({
      row,
      snapshot:   snapshots.get(row.id) ?? null,
      answers:    answers.filter((a) => a.inspection_id === row.id),
      recordOnly: recordOnly.get(row.id) ?? new Set(),
      remediation,
      photos,
    })),
  }
}

// ── The reads ────────────────────────────────────────────────────────────────

const INSPECTION_SELECT = `
  id, property_id, form_version, form_snapshot, header_snapshot,
  started_at, started_at_source, completed_at, inspector_name,
  property:properties!inner(name)
`

/**
 * COMPLETED ONLY, in both shapes.
 *
 * An in-progress walk is not a record — §"Completing it" is that nothing is
 * posted, raised or shown until sign-off — and a downloadable PDF of a
 * half-filled form is the most damaging possible version of that, because it
 * looks exactly like a finished one.
 *
 * `.eq('org_id', …)` on BOTH shapes. The single-inspection form is keyed by an
 * id straight off the URL, so the org filter is the whole thing standing
 * between a PM and another tenant's document — an id-keyed lookup that proves
 * only "the caller belongs to AN org" is the IDOR the standing checklist names.
 */
async function loadInspectionRows(
  supabase: SupabaseClient,
  input:    LoadReportInput,
): Promise<{ rows: InspectionRow[]; totalCompleted: number }> {
  const { orgId, inspectionId, propertyId } = input

  if (inspectionId) {
    const res = await supabase
      .from('inspections')
      .select(INSPECTION_SELECT)
      .eq('org_id', orgId)
      .eq('id', inspectionId)
      .not('completed_at', 'is', null)
      .maybeSingle()

    const row = unwrap(res as PostgrestResult<InspectionRow>, {
      site: 'inspections.report.one', orgId,
    })
    return { rows: row ? [row] : [], totalCompleted: row ? 1 : 0 }
  }

  // `count: 'exact'` is what makes MAX_HISTORY_INSPECTIONS honest. Without the
  // total there is no way to distinguish "this is the whole history" from "this
  // is the most recent 60 of it", and the cover page would assert the second as
  // the first — on a document whose entire claim is completeness.
  const res = await supabase
    .from('inspections')
    .select(INSPECTION_SELECT, { count: 'exact' })
    .eq('org_id', orgId)
    .eq('property_id', propertyId!)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(MAX_HISTORY_INSPECTIONS)

  const rows = unwrapList<InspectionRow>(res as PostgrestResult<InspectionRow[]>, {
    site: 'inspections.report.history', orgId,
  })
  return { rows, totalCompleted: res.count ?? rows.length }
}

/** `.order('id')` is load-bearing: `.range()` pages are only stable under a
 *  stable sort, and an unstable one drops and repeats rows across boundaries. */
async function loadAnswers(
  supabase:      SupabaseClient,
  orgId:         string,
  inspectionIds: string[],
): Promise<AnswerRow[]> {
  return fetchAllRows<AnswerRow>(
    (from, to) => supabase
      .from('inspection_items')
      .select(`
        id, inspection_id, form_item_id, prompt_snapshot, result,
        value_number, value_text, value_date, note, na_reason,
        actions, needs_cleaning, photo_path, photo_unavailable_reason
      `)
      .eq('org_id', orgId)
      .in('inspection_id', inspectionIds)
      .order('id', { ascending: true })
      .range(from, to),
    { maxRows: MAX_ANSWER_ROWS, label: 'inspections.report.answers' },
  )
}

/**
 * Photo bytes, downloaded through the SERVICE client rather than signed.
 *
 * A signed URL would be a second, independently-guessable way into a private
 * bucket, alive for its whole TTL and outside every check the route just ran.
 * The bytes are needed in this process anyway to embed them, so there is
 * nothing to gain by minting one.
 *
 * A photo that fails to download is SKIPPED, not thrown. A missing photograph
 * costs the report one page of corroboration; a throw costs the whole document,
 * including every finding on it. The photo log prints what it has and the
 * inspection body still shows the item.
 */
async function loadPhotos(
  supabase: SupabaseClient,
  answers:  AnswerRow[],
): Promise<Map<string, ReportPhoto>> {
  const out   = new Map<string, ReportPhoto>()
  const paths = answers
    .filter((a) => a.photo_path)
    .slice(0, MAX_REPORT_PHOTOS)

  // Sequential rather than a Promise.all fan-out: this is 10MB-capped binary
  // per object, and firing 150 concurrent downloads is how a report becomes a
  // memory spike rather than a slow response.
  for (const answer of paths) {
    const path = answer.photo_path!
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(path)
    if (error || !data) continue

    const bytes = new Uint8Array(await data.arrayBuffer())
    out.set(answer.id, { path, bytes, format: imageFormat(bytes) })
  }
  return out
}

const PHOTO_BUCKET = 'inspection-photos'

/**
 * Format from the MAGIC BYTES, not from the file extension or the stored MIME.
 *
 * pdf-lib embeds JPEG and PNG and nothing else, and its failure mode on
 * anything else is a throw from inside the render — which would take the whole
 * document down over one photograph. The bucket also allows HEIC and WebP:
 * compression re-encodes to JPEG before upload, so those only arrive on
 * lib/images/compress.ts's fallback path, but "only on the fallback path" is
 * not "never".
 */
function imageFormat(bytes: Uint8Array): ReportPhoto['format'] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  return 'unsupported'
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function buildInspection(input: {
  row:         InspectionRow
  snapshot:    FormSnapshot | null
  answers:     AnswerRow[]
  recordOnly:  Set<string>
  remediation: Awaited<ReturnType<typeof loadRemediationIndex>>
  photos:      Map<string, ReportPhoto>
}): ReportInspection {
  const { row, snapshot, answers, recordOnly, remediation, photos } = input

  const byId = new Map(answers.map((a) => [a.form_item_id, a]))
  const sections: ReportSection[] = []

  // WALKED IN SNAPSHOT ORDER, not in the order the rows came back. The snapshot
  // records the sequence the form was actually filled in (§5), and `.order('id')`
  // on the answer read is a pagination requirement that says nothing about it.
  for (const section of snapshot?.sections ?? []) {
    const built: ReportAnswer[] = []
    for (const item of section.items) {
      const answer = byId.get(item.id)
      // An UNANSWERED item is omitted rather than printed blank. Every item on
      // a completed walk was either answered or gated off by an asset/fact
      // condition it did not meet, and a blank row cannot tell a reader which —
      // it reads as something skipped.
      if (!answer) continue
      built.push(toReportAnswer(answer, recordOnly.has(item.id), remediation, photos, row.id))
    }
    if (built.length > 0) sections.push({ key: section.key, name: section.name, answers: built })
  }

  // A MALFORMED OR ABSENT SNAPSHOT still produces a document. Falling back to
  // the flat answer list loses the section headings and keeps every finding,
  // which is the right way round: the answers are the record, the headings are
  // navigation.
  if (sections.length === 0 && answers.length > 0) {
    sections.push({
      key:  'answers',
      name: 'Inspection items',
      answers: answers.map((a) =>
        toReportAnswer(a, recordOnly.has(a.form_item_id), remediation, photos, row.id)),
    })
  }

  const counted = sections.flatMap((s) => s.answers).filter((a) => !a.isRecordOnly)

  return {
    id:          row.id,
    propertyId:  row.property_id,
    formKey:     snapshot?.form_key ?? '',
    formLabel:   FORM_LABELS[snapshot?.form_key ?? ''] ?? snapshot?.form_key ?? 'Inspection',
    formVersion: row.form_version,
    header:      parseHeaderSnapshot(row.header_snapshot),
    startedAt:       row.started_at,
    startedAtSource: row.started_at_source,
    completedAt:     row.completed_at,
    inspectorName:   row.inspector_name,
    sections,
    // PASSES AND FAILS, not "total minus the other". An item answered N/A is
    // neither, and counting it either way misstates the walk.
    passCount: counted.filter((a) => a.result === 'pass').length,
    failCount: counted.filter((a) => a.result === 'fail').length,
  }
}

function toReportAnswer(
  answer:       AnswerRow,
  isRecordOnly: boolean,
  remediation:  Awaited<ReturnType<typeof loadRemediationIndex>>,
  photos:       Map<string, ReportPhoto>,
  inspectionId: string,
): ReportAnswer {
  return {
    id:     answer.id,
    prompt: answer.prompt_snapshot,
    result: answer.result,
    value:  answerValue(answer),
    note:   answer.note,
    naReason: answer.na_reason,
    actions:  answer.actions ?? [],
    needsCleaning: !!answer.needs_cleaning,
    isRecordOnly,
    photo: photos.get(answer.id) ?? null,
    photoUnavailableReason: answer.photo_unavailable_reason,
    // A record-only item raises nothing by definition, so asking the index for
    // one would return the walk's cleaning roll-up and print "WO-2026-0031,
    // open" against "no alarm system present".
    remediation: isRecordOnly
      ? { kind: 'none' }
      : remediationFor(remediation, answer.id, inspectionId),
  }
}

/**
 * The typed answer for a count / text / date item, as one string.
 *
 * `0` and `''` are real answers and must survive: "0 fire extinguishers" is the
 * finding, not a missing value, so this tests for null explicitly rather than
 * leaning on truthiness.
 */
function answerValue(answer: AnswerRow): string | null {
  if (answer.value_number !== null && answer.value_number !== undefined) {
    return String(answer.value_number)
  }
  if (answer.value_date) return answer.value_date
  if (answer.value_text !== null && answer.value_text !== undefined) return answer.value_text
  return null
}

/** Defensive, for the same reason `parseFormSnapshot` is: it is jsonb. */
function parseHeaderSnapshot(value: unknown): HeaderSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.property_name !== 'string') return null
  return raw as unknown as HeaderSnapshot
}

/** Unwraps the embed both ways — PostgREST's shape depends on the relationship. */
function propertyNameOf(row: InspectionRow): string {
  if (!row.property) return 'Property'
  const p = Array.isArray(row.property) ? row.property[0] : row.property
  return p?.name ?? 'Property'
}

interface InspectionRow {
  id:              string
  property_id:     string
  form_version:    number
  form_snapshot:   unknown
  header_snapshot: unknown
  started_at:      string
  started_at_source: 'server' | 'device'
  completed_at:    string
  inspector_name:  string | null
  property:        { name: string }[] | { name: string } | null
}

interface AnswerRow {
  id:            string
  inspection_id: string
  form_item_id:  string
  prompt_snapshot: string
  result:        string | null
  value_number:  number | null
  value_text:    string | null
  value_date:    string | null
  note:          string | null
  na_reason:     string | null
  actions:       InspectionAction[] | null
  needs_cleaning: boolean | null
  photo_path:    string | null
  photo_unavailable_reason: string | null
}
