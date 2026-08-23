// Runs against real (fake-indexeddb) IndexedDB rather than a stub, because the
// thing under test IS a storage contract: what survives a reload, what a second
// change to the same row does to the first, and what pruning removes.
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  cacheInspection,
  draftRowId,
  pruneFinishedInspections,
  saveAnswer,
  toAnswerStates,
  toCountsByItemId,
} from '@/lib/dexie/dashboard/inspection-draft'
import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'
import type { Inspection } from '@/types/database'

// ============================================================================
// The draft is the ONLY copy of an inspection until sign-off.
//
// That is what `inspection.submit` means: the whole set posts as one atomic
// completion, so for the ninety minutes of a walk there is no server row behind
// any of it. A tablet is locked, backgrounded and reclaimed several times in
// that window, so the failure this store exists to prevent is not a lost
// keystroke — it is a second visit to the property.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const INSP = 'insp-1'

const identity = (answerKey: string, over: Partial<{ formItemId: string }> = {}) => ({
  inspectionId:   INSP,
  answerKey,
  formItemId:     over.formItemId ?? `item-${answerKey}`,
  promptSnapshot: `Prompt for ${answerKey}`,
  assetId:        null,
  repeatIndex:    null,
})

const inspection = (over: Partial<Inspection> = {}): Inspection => ({
  id: INSP, org_id: ORG, property_id: 'prop-1',
  form_id: 'f1', form_version: 1, form_snapshot: {}, header_snapshot: null,
  assigned_to_user_id: USER, inspector_name: null,
  scheduled_for: null, started_at: '2026-08-22T10:00:00Z',
  started_at_source: 'server', device_started_at: null, device_clock_offset_seconds: null,
  completed_at: null, completed_by_user_id: null,
  source_schedule_id: null, corrects_inspection_id: null,
  created_at: '2026-08-22T10:00:00Z', updated_at: '2026-08-22T10:00:00Z',
  ...over,
})

async function reset() {
  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await db.inspection_answers.clear()
  await db.inspections.clear()
}

beforeEach(reset)

describe('saveAnswer — a change is a MERGE, never a replace', () => {
  it('two controls on one item both survive', async () => {
    // Tapping Fail and then typing the description are two changes to one row.
    // A `put` of a freshly-built row would drop whichever landed first, and it
    // would look fine on screen because React still holds both.
    await saveAnswer(USER, ORG, identity('a'), { result: 'fail' })
    await saveAnswer(USER, ORG, identity('a'), { note: 'latch broken' })

    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row).toMatchObject({ result: 'fail', note: 'latch broken' })
  })

  it('a patch that omits a field leaves it alone', async () => {
    // The same rule CLAUDE.md's upload-payload guardrail enforces one layer
    // later: `completed_at: payload.x ?? null` writes a real NULL when the
    // change never mentioned the field. Absent means unchanged.
    await saveAnswer(USER, ORG, identity('a'), { result: 'fail', note: 'cracked pane' })
    await saveAnswer(USER, ORG, identity('a'), { needsCleaning: true })

    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row!.note).toBe('cracked pane')
    expect(row!.needsCleaning).toBe(true)
  })

  it('an explicit null DOES clear — undoing an answer is a real action', async () => {
    await saveAnswer(USER, ORG, identity('a'), { result: 'fail' })
    await saveAnswer(USER, ORG, identity('a'), { result: null })

    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row!.result).toBeNull()
  })

  it('creates the row on first touch, with every field at a real default', async () => {
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })
    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row).toMatchObject({
      inspectionId: INSP, answerKey: 'a', actions: [], needsCleaning: false,
      note: null, photoPath: null, valueNumber: null, valueText: null, valueDate: null,
    })
  })
})

describe('answeredAt tracks whether anything is actually there', () => {
  it('is set once an answer exists, and KEPT on later edits', async () => {
    await saveAnswer(USER, ORG, identity('a'), { result: 'fail' })
    const first = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(first!.answeredAt).not.toBeNull()

    await saveAnswer(USER, ORG, identity('a'), { note: 'later' })
    const second = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(second!.answeredAt).toBe(first!.answeredAt)
  })

  it('is CLEARED when the last value is removed', async () => {
    // Otherwise clearing an answer leaves the progress count and the Review
    // gate both crediting an answer that is no longer there — and the gate
    // would let an emptied item through to a signature.
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })
    await saveAnswer(USER, ORG, identity('a'), { result: null })

    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row!.answeredAt).toBeNull()
  })

  it('a count of zero IS an answer', async () => {
    // Zero extinguishers is a finding, not a blank. Truthiness gets this wrong.
    await saveAnswer(USER, ORG, identity('a'), { valueNumber: 0 })
    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row!.answeredAt).not.toBeNull()
  })

  it('whitespace is not an answer', async () => {
    await saveAnswer(USER, ORG, identity('a'), { valueText: '   ' })
    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, 'a'))
    expect(row!.answeredAt).toBeNull()
  })

  it('a photo, or an honest reason there is none, both count', async () => {
    await saveAnswer(USER, ORG, identity('a'), { photoPath: 'o/i/x.jpg' })
    await saveAnswer(USER, ORG, identity('b'), { photoUnavailableReason: 'tag illegible' })
    const db = getDashboardDb(USER, ORG)
    expect((await db.inspection_answers.get(draftRowId(INSP, 'a')))!.answeredAt).not.toBeNull()
    expect((await db.inspection_answers.get(draftRowId(INSP, 'b')))!.answeredAt).not.toBeNull()
  })
})

describe('answers are scoped to their inspection', () => {
  it('two inspections never share a row, even for the same item', async () => {
    // The row id is `${inspectionId}|${answerKey}` for exactly this reason: the
    // answer key is derived from the FORM, which is the same form both times.
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })
    await saveAnswer(USER, ORG, { ...identity('a'), inspectionId: 'insp-2' }, { result: 'fail' })

    const db = getDashboardDb(USER, ORG)
    expect((await db.inspection_answers.get(draftRowId(INSP, 'a')))!.result).toBe('pass')
    expect((await db.inspection_answers.get(draftRowId('insp-2', 'a')))!.result).toBe('fail')
  })
})

describe('toAnswerStates / toCountsByItemId', () => {
  it('projects rows into what the resolver and the gate read', async () => {
    await saveAnswer(USER, ORG, identity('a'), { result: 'fail', note: 'n' })
    const rows = await getDashboardDb(USER, ORG).inspection_answers.toArray()

    expect(toAnswerStates(rows).a).toMatchObject({ result: 'fail', note: 'n' })
  })

  it('a count feeds the repeat group by its FORM ITEM id, not its answer key', async () => {
    await saveAnswer(USER, ORG, identity('count-key', { formItemId: 'fi-1' }), { valueNumber: 3 })
    const rows = await getDashboardDb(USER, ORG).inspection_answers.toArray()
    expect(toCountsByItemId(rows)).toEqual({ 'fi-1': 3 })
  })

  it('zero is carried through, so "no extinguishers" sizes the group at zero', async () => {
    await saveAnswer(USER, ORG, identity('c', { formItemId: 'fi-1' }), { valueNumber: 0 })
    const rows = await getDashboardDb(USER, ORG).inspection_answers.toArray()
    expect(toCountsByItemId(rows)).toEqual({ 'fi-1': 0 })
  })

  it('an item with no count contributes no entry at all', async () => {
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })
    const rows = await getDashboardDb(USER, ORG).inspection_answers.toArray()
    expect(toCountsByItemId(rows)).toEqual({})
  })
})

describe('pruneFinishedInspections keeps the cache bounded', () => {
  it('drops a completed inspection and its answers together', async () => {
    // A PM running one inspection a week accumulates fifty dead drafts of ~250
    // rows a year, on a device that also holds their maintenance board.
    await cacheInspection(USER, ORG, inspection({ completed_at: '2026-08-22T12:00:00Z' }))
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })

    await pruneFinishedInspections(USER, ORG)

    const db = getDashboardDb(USER, ORG)
    expect(await db.inspections.count()).toBe(0)
    expect(await db.inspection_answers.count()).toBe(0)
  })

  it('NEVER touches an inspection the server has not marked complete', async () => {
    // The predicate is the server's completed_at, never a local flag. A draft
    // whose submit is still in the outbox has been accepted by nobody, and
    // deleting it because the device believes it is done is the "work silently
    // thrown away" failure the dead-letter guardrails exist for.
    await cacheInspection(USER, ORG, inspection())
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })

    await pruneFinishedInspections(USER, ORG)

    const db = getDashboardDb(USER, ORG)
    expect(await db.inspections.count()).toBe(1)
    expect(await db.inspection_answers.count()).toBe(1)
  })

  it('prunes only the finished one when both are cached', async () => {
    await cacheInspection(USER, ORG, inspection({ completed_at: '2026-08-22T12:00:00Z' }))
    await cacheInspection(USER, ORG, inspection({ id: 'insp-2' }))
    await saveAnswer(USER, ORG, identity('a'), { result: 'pass' })
    await saveAnswer(USER, ORG, { ...identity('a'), inspectionId: 'insp-2' }, { result: 'pass' })

    await pruneFinishedInspections(USER, ORG)

    const db = getDashboardDb(USER, ORG)
    expect((await db.inspections.toArray()).map((i) => i.id)).toEqual(['insp-2'])
    expect((await db.inspection_answers.toArray()).map((r) => r.inspectionId)).toEqual(['insp-2'])
  })

  it('is a no-op on an empty cache rather than an error', async () => {
    await expect(pruneFinishedInspections(USER, ORG)).resolves.toBeUndefined()
  })
})
