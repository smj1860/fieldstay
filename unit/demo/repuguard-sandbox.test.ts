import { describe, it, expect } from 'vitest'
import {
  SANDBOX_REVIEWS, revealedLength, totalRevealMs,
  TICK_MS, CHARS_PER_TICK,
} from '@/lib/demo/repuguard-sandbox'
import { REPUGUARD_SYSTEM_PROMPT } from '@/lib/repuguard/generate-response'

// The sandbox replays authored responses rather than calling the model. That
// is only honest if the authored copy obeys the same rules the real system
// prompt enforces — otherwise the booth demo shows behavior the product does
// not have. These tests pin the rules that matter.

describe('sandbox reveal timing', () => {
  it('reveals nothing at or before zero elapsed', () => {
    expect(revealedLength(0, 100)).toBe(0)
    expect(revealedLength(-50, 100)).toBe(0)
  })

  it('reveals CHARS_PER_TICK characters per tick', () => {
    expect(revealedLength(TICK_MS, 100)).toBe(CHARS_PER_TICK)
    expect(revealedLength(TICK_MS * 4, 100)).toBe(CHARS_PER_TICK * 4)
  })

  it('never exceeds the total length — the slice() call depends on this', () => {
    expect(revealedLength(TICK_MS * 10_000, 42)).toBe(42)
  })

  it('is monotonic across the full reveal', () => {
    const total = 500
    let prev = 0
    for (let t = 0; t <= totalRevealMs(total) + TICK_MS; t += TICK_MS) {
      const n = revealedLength(t, total)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
    expect(prev).toBe(total)
  })

  it('completes a typical response in a booth-appropriate time', () => {
    // Long enough to read along with, short enough not to stall a
    // conversation. Guards against someone "tuning" it into a 30s crawl.
    for (const r of SANDBOX_REVIEWS) {
      const ms = totalRevealMs(r.generated.response.length)
      expect(ms).toBeGreaterThan(500)
      expect(ms).toBeLessThan(8_000)
    }
  })
})

describe('sandbox scenario integrity', () => {
  it('has unique ids — selection is keyed on them', () => {
    const ids = SANDBOX_REVIEWS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers the full star range, not just the dramatic ones', () => {
    const ratings = SANDBOX_REVIEWS.map((r) => r.starRating)
    expect(Math.min(...ratings)).toBe(1)
    expect(Math.max(...ratings)).toBe(5)
  })

  it('includes at least one clean response and one held response', () => {
    expect(SANDBOX_REVIEWS.some((r) => r.generated.flags.length === 0)).toBe(true)
    expect(SANDBOX_REVIEWS.some((r) => r.generated.flags.length > 0)).toBe(true)
  })

  it('every flagged scenario explains why it was held', () => {
    for (const r of SANDBOX_REVIEWS) {
      if (r.generated.flags.length > 0) {
        expect(r.generated.flag_reason, `${r.id} is flagged but has no flag_reason`).toBeTruthy()
      } else {
        expect(r.generated.flag_reason, `${r.id} is unflagged but has a flag_reason`).toBeNull()
      }
    }
  })

  it('uses only flag values the real system prompt knows about', () => {
    const allowed = new Set(['legal', 'billing', 'safety'])
    for (const r of SANDBOX_REVIEWS) {
      for (const f of r.generated.flags) {
        expect(allowed.has(f), `${r.id} uses unknown flag "${f}"`).toBe(true)
      }
    }
  })

  it('word_count matches the actual response text', () => {
    for (const r of SANDBOX_REVIEWS) {
      const actual = r.generated.response.trim().split(/\s+/).length
      // Authored copy, so exactness is achievable — but allow a small margin
      // for hyphenation/punctuation tokenization differences.
      expect(
        Math.abs(actual - r.generated.word_count),
        `${r.id}: word_count says ${r.generated.word_count}, text has ${actual}`,
      ).toBeLessThanOrEqual(3)
    }
  })

  it('never leaks an internal note verbatim into a public response', () => {
    // The whole selling point of the mixed-review scenario is that internal
    // context INFORMS the reply without being pasted into it.
    for (const r of SANDBOX_REVIEWS) {
      if (r.internalNotes === null) continue
      expect(r.generated.response).not.toContain(r.internalNotes)
    }
  })
})

describe('defamation safeguard', () => {
  const held = SANDBOX_REVIEWS.find((r) => r.id === 'sbx-defamation')!

  it('exists — the safeguard scenario is the point of the deck', () => {
    expect(held).toBeDefined()
  })

  it('flags both legal and safety, per the system prompt', () => {
    expect(held.generated.flags).toEqual(expect.arrayContaining(['legal', 'safety']))
  })

  it('reproduces the prompt-mandated hold text verbatim', () => {
    // The real prompt requires this exact string and nothing else for
    // criminal/defamatory allegations. If the prompt's wording is ever
    // changed, this test fails and the sandbox copy must be updated with it —
    // that coupling is deliberate.
    const mandated =
      'This response has been held pending internal review. ' +
      'Please contact your FieldStay support team before posting any public reply.'

    expect(REPUGUARD_SYSTEM_PROMPT).toContain(mandated)
    expect(held.generated.response.replace(/\s+/g, ' ')).toBe(mandated)
  })
})
