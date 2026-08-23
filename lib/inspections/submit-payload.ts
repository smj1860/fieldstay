// lib/inspections/submit-payload.ts
//
// Validating a signed-off inspection that arrived from a device.
//
// Separate from the route handler because it is pure, and because it is the
// part worth testing: the payload was assembled on a tablet, held in IndexedDB
// possibly across a release, and posted back by a background drain. None of
// that makes it hostile; none of it makes it trustworthy either. The RPC behind
// the route casts straight into enum columns, where a bad value is a 500 rather
// than a message an inspector can act on.
//
// The bias throughout is: reject a wrong SHAPE, tolerate a missing value. A
// rejection here is TERMINAL for the outbox — it dead-letters a completed walk
// whose answers exist nowhere else — so anything that can be read as "the
// inspector did not fill this in" must not be read as "the payload is corrupt".

import type { InspectionAction, InspectionRepeatAnswer, InspectionResult } from '@/types/database'

/**
 * One answer, as the device queued it.
 *
 * A `type` alias rather than an interface, and not stylistically: TypeScript
 * gives an object type ALIAS an implicit index signature and denies one to an
 * interface, so only the alias is assignable to `Json` — which this must be,
 * because it is passed straight into a jsonb RPC parameter. Same reason
 * FormSnapshot is an alias; the alternative is an `as unknown as Json` that
 * would suppress a real shape mismatch just as readily as this one.
 */
export type SubmittedItem = {
  form_item_id:    string
  prompt_snapshot: string
  result:          InspectionResult | null
  actions:         InspectionAction[]
  needs_cleaning:  boolean
  note:            string | null
  photo_path:      string | null
  photo_unavailable_reason: string | null
  na_reason:       string | null
  value_number:    number | null
  value_text:      string | null
  value_date:      string | null
  asset_id:        string | null
  repeat_index:    number | null
  answered_at:     string | null
  repeat_answer:           InspectionRepeatAnswer | null
  repeat_of_work_order_id: string | null
}

const RESULTS = new Set<string>(['pass', 'fail', 'na'])
const ACTIONS = new Set<string>(['repair', 'service', 'replace'])
const REPEAT_ANSWERS = new Set<string>(['same', 'new'])

/**
 * The most answers one inspection may carry.
 *
 * The largest form is 55 root items, and repeat groups are capped at 999
 * instances each — so a legitimate inspection is in the hundreds and a request
 * in the tens of thousands is a bug or an attack, not a thorough walk. Bounded
 * here because the RPC will happily insert whatever it is handed.
 */
export const MAX_ITEMS = 5_000

/** Free text off a device. Long enough for a real description, not a payload. */
export const MAX_TEXT = 2_000

export type ParseResult =
  | { inspectorName: string; items: SubmittedItem[] }
  | { error: string }

/**
 * Validate at the boundary rather than trusting the device.
 *
 * This payload was assembled on a tablet, held in IndexedDB — possibly across a
 * release — and posted back by a background drain. None of that makes it
 * hostile, but none of it makes it trustworthy either, and the RPC casts
 * straight into enum columns where a bad value is a 500 rather than a message.
 */
export function parseSubmitPayload(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const raw = body as { inspectorName?: unknown; items?: unknown }

  const inspectorName = typeof raw.inspectorName === 'string' ? raw.inspectorName.trim() : ''
  // §5: the signature is the artifact's point. An unsigned completion is not a
  // certification, so this is rejected rather than defaulted.
  if (!inspectorName) return { error: 'An inspector name is required to sign off.' }
  if (inspectorName.length > 200) return { error: 'That inspector name is too long.' }

  if (!Array.isArray(raw.items)) return { error: 'Malformed request.' }
  if (raw.items.length === 0) return { error: 'An inspection with no answers cannot be signed off.' }
  if (raw.items.length > MAX_ITEMS) return { error: 'That inspection has too many answers.' }

  const items: SubmittedItem[] = []
  for (const entry of raw.items) {
    const item = parseItem(entry)
    if (!item) return { error: 'Malformed request.' }
    items.push(item)
  }

  return { inspectorName, items }
}

function parseItem(entry: unknown): SubmittedItem | null {
  if (!entry || typeof entry !== 'object') return null
  const r = entry as Record<string, unknown>

  if (typeof r.form_item_id !== 'string') return null
  if (typeof r.prompt_snapshot !== 'string' || r.prompt_snapshot.length > MAX_TEXT) return null

  const result = parseResult(r.result)
  if (result === false) return null

  const actions = parseActions(r.actions)
  if (actions === false) return null

  const valueNumber = optionalInt(r.value_number)
  if (valueNumber === false) return null
  // Matches inspection_items_value_number_range. Rejected here so the inspector
  // gets a message instead of a CHECK violation surfacing as "could not submit".
  if (valueNumber !== null && (valueNumber < 0 || valueNumber > 999)) return null

  const repeatIndex = optionalInt(r.repeat_index)
  if (repeatIndex === false) return null

  const repeat = parseRepeatAnswer(r)
  if (repeat === false) return null

  const text = parseTextFields(r)
  if (text === false) return null

  return {
    form_item_id:    r.form_item_id,
    prompt_snapshot: r.prompt_snapshot,
    result,
    actions,
    needs_cleaning:  r.needs_cleaning === true,
    ...text,
    value_number:    valueNumber,
    asset_id:        typeof r.asset_id === 'string' ? r.asset_id : null,
    repeat_index:    repeatIndex,
    answered_at:     typeof r.answered_at === 'string' ? r.answered_at : null,
    ...repeat,
  }
}

/**
 * Typed, not stringified. `String(someObject)` is "[object Object]", which
 * happens to fail the membership check and so reaches the right answer by
 * accident — but only for as long as no enum value is ever named that. The
 * narrowing says what is meant: an answer is a string or it is absent.
 */
function parseResult(value: unknown): InspectionResult | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !RESULTS.has(value)) return false
  return value as InspectionResult
}

/**
 * Same reasoning as parseResult: `.map(String)` would coerce a nested object
 * into a string that merely fails the check rather than being rejected as the
 * wrong shape.
 *
 * NULLISH stays lenient, deliberately. The old code turned any non-array into
 * `[]`, and tightening that all the way would make `actions: null` — which a
 * serializer can plausibly emit for an empty list — dead-letter an entire
 * signed-off walk. Absent means no actions; a wrong SHAPE is still rejected.
 */
function parseActions(value: unknown): InspectionAction[] | false {
  if (value !== null && value !== undefined && !Array.isArray(value)) return false
  const actions = (value ?? []) as unknown[]
  if (actions.some((a) => typeof a !== 'string' || !ACTIONS.has(a))) return false
  return actions as InspectionAction[]
}

/** The six free-text columns, all bounded the same way. `false` = one was invalid. */
function parseTextFields(r: Record<string, unknown>):
  | Pick<SubmittedItem, 'note' | 'photo_path' | 'photo_unavailable_reason' | 'na_reason' | 'value_text' | 'value_date'>
  | false {
  const keys = [
    'note', 'photo_path', 'photo_unavailable_reason', 'na_reason', 'value_text', 'value_date',
  ] as const

  const out = {} as Record<(typeof keys)[number], string | null>
  for (const key of keys) {
    const parsed = optionalText(r[key])
    if (parsed === false) return false
    out[key] = parsed
  }
  return out
}

/**
 * §6's repeat answer, and the ONE pairing rule that used to be a database CHECK.
 *
 * It could not stay one: `repeat_of_work_order_id` is ON DELETE SET NULL, so
 * deleting the referenced work order produces exactly the state the constraint
 * forbade, and the DELETE failed — by cascade, that made deleting an
 * ORGANIZATION fail (20260823180811). A CHECK cannot say "at INSERT time only",
 * so the rule lives here, at the boundary where the payload is already vetted.
 *
 * The pair is REJECTED rather than silently dropped: an answer with nothing to
 * be an answer about is a client bug, and quietly discarding it would make the
 * inspector's tap disappear with no sign it ever happened.
 *
 * `false` means present-but-invalid, the same convention as the helpers below.
 */
function parseRepeatAnswer(r: Record<string, unknown>):
  | { repeat_answer: InspectionRepeatAnswer | null; repeat_of_work_order_id: string | null }
  | false {
  const answer = r.repeat_answer
  const workOrderId = typeof r.repeat_of_work_order_id === 'string'
    ? r.repeat_of_work_order_id
    : null

  if (answer === null || answer === undefined) {
    // A reference with no answer is harmless — remediation only reads it when
    // there IS an answer — so it is tolerated rather than rejected.
    return { repeat_answer: null, repeat_of_work_order_id: workOrderId }
  }
  if (typeof answer !== 'string' || !REPEAT_ANSWERS.has(answer)) return false
  if (!workOrderId) return false

  // Kept for BOTH answers. On 'new' it is the record of what this finding was
  // distinguished FROM.
  return { repeat_answer: answer as InspectionRepeatAnswer, repeat_of_work_order_id: workOrderId }
}

/** `false` means present-but-invalid, which is different from absent. */
function optionalText(value: unknown): string | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return false
  return value.length > MAX_TEXT ? false : value
}

function optionalInt(value: unknown): number | null | false {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  return value
}
