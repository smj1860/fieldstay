// lib/dexie/dashboard/inspection-draft.ts
//
// The fill screen's local store: reading a cached inspection, writing answers,
// and keeping both bounded.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY EVERY TAP COMMITS, WHEN NOTHING IS SENT UNTIL SIGN-OFF
//
// The answers do not reach the server until `inspection.submit`. That could
// have meant holding them in React state for the length of the walk, and it
// would have looked identical right up to the moment it mattered: a ninety
// minute inspection is long enough for a tablet to be locked, backgrounded and
// reclaimed several times over, and the failure is not a lost keystroke but an
// entire re-walk of the property.
//
// So every change is a Dexie write, immediately. The cost is one small IDB
// transaction per tap; the alternative costs a second visit.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS BOUNDED, EXPLICITLY
//
// CLAUDE.md's rule for the crew cache — "every cached table is bounded, and
// every dead-letterable mutation is visible" — was written because `messages`
// grew forever at 500 rows a pull. Nothing mechanically enforces it on the
// dashboard side yet, which makes it easier to skip here, not less important:
// a PM who runs one inspection a week for a year accumulates fifty dead drafts
// of ~250 rows each on a device that also holds their maintenance board.
//
// Both tables are pruned by `pruneFinishedInspections`, called on every fill
// screen mount. The predicate is "the server says this is complete", never a
// local flag — a draft whose submit has not landed must survive.

import { getDashboardDb, type InspectionAnswerRow } from './schema'
import type { AnswerState } from '@/lib/inspections/resolve-form'
import type { Inspection } from '@/types/database'

/** `${inspectionId}|${answerKey}` — one row per rendered instance. */
export function draftRowId(inspectionId: string, answerKey: string): string {
  return `${inspectionId}|${answerKey}`
}

/**
 * What a single change carries. Every field is optional and ABSENT MEANS
 * UNCHANGED — never "set to null".
 *
 * That distinction is the same one CLAUDE.md's upload-payload rule is about,
 * moved one layer earlier. A patch that spelled every field would let a
 * photo-only change blank the note the inspector typed a minute ago, and it
 * would do it silently because the write succeeds.
 */
export type AnswerPatch = Partial<Omit<
  InspectionAnswerRow,
  'id' | 'inspectionId' | 'answerKey' | 'formItemId' | 'promptSnapshot' | 'updatedAt' | 'answeredAt'
>>

interface AnswerIdentity {
  inspectionId:   string
  answerKey:      string
  formItemId:     string
  promptSnapshot: string
  assetId:        string | null
  repeatIndex:    number | null
}

const EMPTY: Omit<InspectionAnswerRow, keyof AnswerIdentity | 'id' | 'updatedAt' | 'answeredAt'> = {
  result:        null,
  actions:       [],
  needsCleaning: false,
  note:          null,
  photoPath:     null,
  photoUnavailableReason: null,
  naReason:      null,
  valueNumber:   null,
  valueText:     null,
  valueDate:     null,
}

/**
 * Applies one change to one answer, creating the row if this is its first.
 *
 * Read-modify-write inside a transaction rather than a bare `put`: two controls
 * on the same item (tapping Fail, then typing the description) are two changes
 * to one row, and a `put` of a freshly-built row would drop whichever landed
 * first. The transaction is what makes the pair safe when they overlap.
 */
export async function saveAnswer(
  userId:   string,
  orgId:    string,
  identity: AnswerIdentity,
  patch:    AnswerPatch,
): Promise<void> {
  const db = getDashboardDb(userId, orgId)
  const id = draftRowId(identity.inspectionId, identity.answerKey)
  const now = new Date().toISOString()

  await db.transaction('rw', db.inspection_answers, async () => {
    const existing = await db.inspection_answers.get(id)
    const merged: InspectionAnswerRow = {
      ...EMPTY,
      ...identity,
      ...existing,
      ...patch,
      id,
      updatedAt: now,
      // Recomputed from the merged row, not carried from `existing`: clearing
      // the last value on an item has to un-answer it, or the progress count
      // and the Review gate would both keep crediting an answer that is gone.
      answeredAt: null,
    }
    merged.answeredAt = isAnswered(merged) ? (existing?.answeredAt ?? now) : null
    await db.inspection_answers.put(merged)
  })
}

/**
 * Whether a row holds anything at all.
 *
 * Deliberately type-agnostic, unlike the Review gate's `hasAnswer`, which knows
 * the item's `response_type`. This one only has the row, and its job is
 * narrower: has the inspector put ANYTHING here. The gate stays the authority
 * on whether what they put is the right kind of thing.
 */
function isAnswered(row: InspectionAnswerRow): boolean {
  return row.result !== null
    || row.valueNumber !== null
    || !!row.valueText?.trim()
    || !!row.valueDate?.trim()
    || !!row.photoPath
    || !!row.photoUnavailableReason?.trim()
}

/** Every answer for one inspection, keyed the way the resolver keys them. */
export function toAnswerStates(rows: InspectionAnswerRow[]): Record<string, AnswerState> {
  const out: Record<string, AnswerState> = {}
  for (const row of rows) {
    out[row.answerKey] = {
      result:      row.result,
      note:        row.note,
      photoPath:   row.photoPath,
      photoUnavailableReason: row.photoUnavailableReason,
      valueNumber: row.valueNumber,
      valueText:   row.valueText,
      valueDate:   row.valueDate,
    }
  }
  return out
}

/**
 * Counts answered so far, keyed by the COUNT item's id — what `resolveFormPages`
 * takes to size a repeat group.
 *
 * Keyed by `formItemId` rather than `answerKey` because a count item is never
 * itself inside a repeat group or a per-asset sweep, so its two keys coincide.
 * If that ever stops being true this needs the full key and the resolver's
 * `countsByItemId` needs to change with it.
 */
export function toCountsByItemId(rows: InspectionAnswerRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    if (row.valueNumber !== null && row.valueNumber !== undefined) {
      out[row.formItemId] = row.valueNumber
    }
  }
  return out
}

/**
 * Drops the cached row and every draft answer for inspections the SERVER says
 * are finished.
 *
 * The predicate is the server's `completed_at`, never a local flag. A draft
 * whose submit is still sitting in the outbox has not been accepted by anyone
 * yet, and deleting it because the device believes it is done is exactly the
 * "work silently thrown away" failure the dead-letter guardrails exist for.
 */
export async function pruneFinishedInspections(userId: string, orgId: string): Promise<void> {
  const db = getDashboardDb(userId, orgId)

  const finished = await db.inspections.filter((i) => !!i.completed_at).toArray()
  if (finished.length === 0) return

  const ids = new Set(finished.map((i) => i.id))
  await db.transaction('rw', db.inspections, db.inspection_answers, async () => {
    await db.inspections.bulkDelete([...ids])
    const orphaned = await db.inspection_answers
      .filter((row) => ids.has(row.inspectionId))
      .primaryKeys()
    await db.inspection_answers.bulkDelete(orphaned)
  })
}

/** Puts a freshly-pulled inspection into the cache without touching its draft. */
export async function cacheInspection(
  userId: string,
  orgId:  string,
  inspection: Inspection,
): Promise<void> {
  await getDashboardDb(userId, orgId).inspections.put(inspection)
}
