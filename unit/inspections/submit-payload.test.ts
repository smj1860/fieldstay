import { describe, expect, it } from 'vitest'

import { parseSubmitPayload, MAX_ITEMS, MAX_TEXT } from '@/lib/inspections/submit-payload'

// ============================================================================
// THE BIAS HERE IS ASYMMETRIC, AND ON PURPOSE.
//
// A rejection is TERMINAL for the outbox: the submit dead-letters, and the
// answers exist nowhere but the tablet that sent them. So anything readable as
// "the inspector did not fill this in" must NOT be read as "the payload is
// corrupt" — while a genuinely wrong SHAPE still has to be caught, because the
// RPC behind this casts straight into enum columns where a bad value is a 500
// rather than a message anyone can act on.
// ============================================================================

const item = (over: Record<string, unknown> = {}) => ({
  form_item_id: '11111111-1111-1111-1111-111111111111',
  prompt_snapshot: 'Smoke detectors present',
  result: 'pass',
  ...over,
})

const body = (over: Record<string, unknown> = {}) => ({
  inspectorName: 'A. Inspector',
  items: [item()],
  ...over,
})

const ok = (b: unknown) => {
  const r = parseSubmitPayload(b)
  if ('error' in r) throw new Error(`expected success, got: ${r.error}`)
  return r
}
const err = (b: unknown) => {
  const r = parseSubmitPayload(b)
  if (!('error' in r)) throw new Error('expected a rejection')
  return r.error
}

describe('parseSubmitPayload — the signature', () => {
  it('accepts a complete payload', () => {
    expect(ok(body())).toMatchObject({ inspectorName: 'A. Inspector' })
  })

  it('requires an inspector name — an unsigned completion is not a certification', () => {
    expect(err(body({ inspectorName: '' }))).toMatch(/inspector name is required/)
    expect(err(body({ inspectorName: '   ' }))).toMatch(/inspector name is required/)
    expect(err(body({ inspectorName: undefined }))).toMatch(/inspector name is required/)
  })

  it('trims the name rather than storing the padding', () => {
    expect(ok(body({ inspectorName: '  A. Inspector  ' })).inspectorName).toBe('A. Inspector')
  })

  it('refuses an inspection with no answers', () => {
    expect(err(body({ items: [] }))).toMatch(/no answers/)
  })

  it('refuses a payload far past any real walk', () => {
    expect(err(body({ items: Array.from({ length: MAX_ITEMS + 1 }, () => item()) })))
      .toMatch(/too many answers/)
  })
})

describe('parseSubmitPayload — shapes rejected, absences tolerated', () => {
  it('a result that is an OBJECT is rejected as a shape, not coerced', () => {
    // This used to be `String(result)`, which renders an object as
    // "[object Object]" — not in the enum, so it happened to fail. Correct by
    // accident holds only until some enum value is named that.
    expect(err(body({ items: [item({ result: {} })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ result: 42 })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ result: 'maybe' })] }))).toMatch(/Malformed/)
  })

  it('a MISSING result is fine — four of five response types have none', () => {
    // Only yes_no answers with a verdict. A count, a date, a text or a photo
    // item legitimately carries `result: null`.
    expect(ok(body({ items: [item({ result: null })] }))).toBeTruthy()
    expect(ok(body({ items: [item({ result: undefined })] }))).toBeTruthy()
  })

  it('actions must be strings from the enum', () => {
    expect(ok(body({ items: [item({ actions: ['repair', 'replace'] })] }))).toBeTruthy()
    expect(err(body({ items: [item({ actions: ['demolish'] })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ actions: [{}] })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ actions: 'repair' })] }))).toMatch(/Malformed/)
  })

  it('NULLISH actions mean none, and do NOT dead-letter the walk', () => {
    // Deliberately lenient, and the asymmetry is the point: `actions: null` is
    // something a serializer plausibly emits for an empty list, and rejecting
    // it would throw away a whole signed-off inspection over a punctuation
    // difference. A wrong SHAPE is still caught, above.
    expect(ok(body({ items: [item({ actions: null })] })).items[0]!.actions).toEqual([])
    expect(ok(body({ items: [item({ actions: undefined })] })).items[0]!.actions).toEqual([])
  })

  it('needs_cleaning is strictly boolean true, never truthy', () => {
    expect(ok(body({ items: [item({ needs_cleaning: true })] })).items[0]!.needs_cleaning).toBe(true)
    expect(ok(body({ items: [item({ needs_cleaning: 'yes' })] })).items[0]!.needs_cleaning).toBe(false)
    expect(ok(body({ items: [item()] })).items[0]!.needs_cleaning).toBe(false)
  })
})

describe('parseSubmitPayload — the value columns', () => {
  it('a count must be a whole number in range', () => {
    expect(ok(body({ items: [item({ value_number: 3 })] })).items[0]!.value_number).toBe(3)
    // Zero extinguishers is a finding, not a blank.
    expect(ok(body({ items: [item({ value_number: 0 })] })).items[0]!.value_number).toBe(0)
    expect(err(body({ items: [item({ value_number: 2.5 })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ value_number: -1 })] }))).toMatch(/Malformed/)
    // Matches inspection_items_value_number_range, so the inspector gets a
    // message instead of a CHECK violation surfacing as "could not submit".
    expect(err(body({ items: [item({ value_number: 1000 })] }))).toMatch(/Malformed/)
    expect(ok(body({ items: [item({ value_number: 999 })] }))).toBeTruthy()
  })

  it('free text is bounded', () => {
    expect(ok(body({ items: [item({ note: 'x'.repeat(MAX_TEXT) })] }))).toBeTruthy()
    expect(err(body({ items: [item({ note: 'x'.repeat(MAX_TEXT + 1) })] }))).toMatch(/Malformed/)
  })

  it('a text field of the wrong type is rejected, but absent is null', () => {
    expect(err(body({ items: [item({ note: 42 })] }))).toMatch(/Malformed/)
    expect(ok(body({ items: [item()] })).items[0]!.note).toBeNull()
  })

  it('carries every value column through unchanged', () => {
    const parsed = ok(body({ items: [item({
      result: 'fail', note: 'latch broken', actions: ['repair'], needs_cleaning: true,
      value_number: 2, value_text: 'under sink', value_date: '2028-04-01',
      photo_path: 'o/i/x.jpg', photo_unavailable_reason: null, na_reason: null,
      asset_id: '33333333-3333-3333-3333-333333333333', repeat_index: 2,
      answered_at: '2026-08-23T10:00:00Z',
    })] }))

    expect(parsed.items[0]).toMatchObject({
      result: 'fail', note: 'latch broken', actions: ['repair'], needs_cleaning: true,
      value_number: 2, value_text: 'under sink', value_date: '2028-04-01',
      asset_id: '33333333-3333-3333-3333-333333333333', repeat_index: 2,
    })
  })
})

describe('parseSubmitPayload — the request itself', () => {
  it('rejects anything that is not an object with items', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(() => ok(bad)).toThrow()
    }
    expect(err({ inspectorName: 'A' })).toMatch(/Malformed/)
    expect(err(body({ items: 'nope' }))).toMatch(/Malformed/)
  })

  it('rejects an item missing its identity', () => {
    expect(err(body({ items: [item({ form_item_id: undefined })] }))).toMatch(/Malformed/)
    expect(err(body({ items: [item({ prompt_snapshot: undefined })] }))).toMatch(/Malformed/)
  })

  it('one bad item rejects the whole submission', () => {
    // Not partial acceptance. A completion is one atomic artifact — accepting
    // the readable half would file an inspection that is missing answers the
    // inspector gave, which is worse than refusing and keeping them on device.
    expect(err(body({ items: [item(), item({ result: 'maybe' })] }))).toMatch(/Malformed/)
  })
})
