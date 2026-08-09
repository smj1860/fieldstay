import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Guardrail: every email sent from inside an Inngest step carries an
// idempotency key.
//
// An Inngest step is retried on ANY failure, including one that happens after
// the work inside it already succeeded — a transport error returning the
// step's result, a platform timeout a millisecond after the send, a thrown
// error from a line below it. `resend.emails.send()` is not idempotent by
// default, so a replayed step sends the email again.
//
// Nothing about that is theoretical for this codebase: 18 of 22 Inngest files
// that send email already pass a key, using a consistent `<slug>-<stable-id>`
// convention. The four that did not (2026-08-09) were not deliberate
// exceptions — they were the same omission four times, and in each the reason
// for the key was already written down next to a sibling call:
//
//   work-order-invoice.ts        — its own paid sibling, one file over, keys on
//                                  the invoice id. This one would tell a PM
//                                  twice that money is due.
//   build-shopping-cart.ts       — last step of an eight-step run against the
//                                  Kroger API; a replay re-announces a cart
//                                  that was already built and already reported.
//   notify-crew-feedback.ts      — retries: 3.
//   on-failure.ts                — the dead-letter alert itself.
//
// A missing key is invisible in every way that matters: the code is correct,
// the tests pass, the send succeeds. The only symptom is a duplicate landing
// in someone's inbox, at a moment when something else was already going wrong.
// That is exactly the class of defect a structural check exists for.
//
// Scope is lib/inngest/** because that is where step-replay applies. A Server
// Action or Route Handler is not retried by a framework, so the same call
// there is a different risk with a different answer.
// ============================================================================

const SEND_CALL = /\b(?:resend\.emails\.send|resend\.batch\.send)\s*\(/g

/**
 * Blank out comments, preserving byte offsets so reported line numbers stay
 * correct. Same treatment unbounded-fanout-loops.test.ts applies, for a
 * sharper reason: the balanced walk below tracks string literals, and an
 * apostrophe in ordinary prose opens one that never closes.
 *
 * That is not hypothetical. ical-sync.ts documents its key with "retries of
 * the *same* step won't double-send" — the apostrophe in "won't" swallowed
 * everything up to the next quote, including the `idempotencyKey` sitting two
 * lines below it, and the one file whose comment explains the rule was
 * reported as breaking it. A check defeated by prose punctuation teaches
 * people to write worse comments.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let inString: string | null = null

  while (i < src.length) {
    const ch   = src[i] as string
    const next = src[i + 1]

    if (inString) {
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (ch === inString) inString = null
      out += ch; i++; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; out += ch; i++; continue }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '; i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '; i += 2
      continue
    }
    out += ch; i++
  }
  return out
}

/**
 * Does the argument list of the call starting at `openIdx` include an
 * `idempotencyKey`?
 *
 * Brace/paren-balanced rather than a line window: these calls span 20+ lines
 * with nested object literals, template strings and an awaited render() in the
 * middle, and the options object is the LAST argument. A fixed lookahead would
 * either miss it or run into the next statement.
 */
function callHasIdempotencyKey(src: string, openIdx: number): boolean {
  let depth = 0
  let inString: string | null = null

  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i] as string
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1).includes('idempotencyKey')
    }
  }
  return false
}

/**
 * A send whose duplicate is genuinely harmless or whose identity is genuinely
 * unavailable. Adding one is a review event: "I could not think of a key" is
 * not a reason — `event.id` is stable across step retries and distinct per
 * delivery, which is a usable key for any event-triggered function that has no
 * domain id (see notify-crew-feedback.ts).
 */
const EXCEPTIONS: Record<string, string> = {}

function findOffenders(): string[] {
  const offenders: string[] = []

  for (const file of collectSourceFiles(['lib/inngest'])) {
    const key = rel(file)
    if (key in EXCEPTIONS) continue

    const src = stripComments(read(file))
    for (const m of src.matchAll(SEND_CALL)) {
      const openIdx = src.indexOf('(', m.index as number)
      if (openIdx === -1) continue
      if (callHasIdempotencyKey(src, openIdx)) continue
      offenders.push(`${key}:${src.slice(0, m.index).split('\n').length}`)
    }
  }

  return offenders
}

describe('guardrail: emails sent from an Inngest step carry an idempotency key', () => {
  it('every resend send in lib/inngest/** passes an idempotencyKey', () => {
    const offenders = findOffenders()
    expect(
      offenders,
      offenders.length
        ? 'These resend sends inside Inngest functions have no idempotencyKey:\n' +
          offenders.map((o) => `  - ${o}`).join('\n') +
          '\n\nAn Inngest step is replayed on any failure, including one that happens ' +
          'AFTER the send succeeded, so the recipient gets the email twice. Pass ' +
          '`{ idempotencyKey: "<slug>-<stable-id>" }` as the second argument — a ' +
          'domain id where one exists, `event.id` where none does, or org + day for ' +
          'a daily cron (daily-wrapup.ts is the reference). Resend\'s window is 24h, ' +
          'so a key is protection against RETRIES, not a substitute for a DB claim ' +
          'when the same job re-fires on a schedule.'
        : '',
    ).toEqual([])
  })

  it('the check actually recognises a send — it must not pass by finding nothing', () => {
    // A guardrail at zero because its matcher broke looks identical to one at
    // zero because the tree is clean. This pins that the scan still sees the
    // construct it is meant to police.
    let seen = 0
    for (const file of collectSourceFiles(['lib/inngest'])) {
      seen += Array.from(stripComments(read(file)).matchAll(SEND_CALL)).length
    }
    expect(seen).toBeGreaterThan(15)
  })

  it('recognises the key in the LAST argument, past a multi-line body', () => {
    // The options object always trails a large inline object with nested
    // literals and template strings. A line-window scan would miss it; this
    // pins the balanced walk that replaced one.
    const sample = [
      'await resend.emails.send({',
      "  from: FROM,",
      "  to: pmEmail,",
      "  subject: `x ${a} (${b.map(c => `${c}`).join(', ')})`,",
      '  html: await render({ body: "()" }),',
      '}, { idempotencyKey: `k-${id}` })',
    ].join('\n')

    expect(callHasIdempotencyKey(sample, sample.indexOf('('))).toBe(true)

    const without = sample.replace(', { idempotencyKey: `k-${id}` }', '')
    expect(callHasIdempotencyKey(without, without.indexOf('('))).toBe(false)
  })

  it('is not defeated by an apostrophe in a comment', () => {
    // The regression that found stripComments: ical-sync.ts's key is
    // documented with "won't double-send", and the apostrophe opened a string
    // literal that ran past the idempotencyKey two lines below. The one file
    // that explained the rule was the one reported as breaking it.
    const sample = [
      'await resend.emails.send(',
      '  { from: FROM, to: pmEmail },',
      "  // retries of the *same* step won't double-send",
      '  { idempotencyKey: `k-1` }',
      ')',
    ].join('\n')

    const stripped = stripComments(sample)
    expect(callHasIdempotencyKey(stripped, stripped.indexOf('('))).toBe(true)
  })

  it('every EXCEPTIONS entry still sends an email (prune when code moves)', () => {
    for (const key of Object.keys(EXCEPTIONS)) {
      const file = collectSourceFiles(['lib/inngest']).find((f) => rel(f) === key)
      expect(file, `EXCEPTIONS lists ${key}, which no longer exists — remove the stale entry.`)
        .toBeDefined()
      expect(
        SEND_CALL.test(read(file as string)),
        `EXCEPTIONS lists ${key}, which no longer sends email — remove the stale entry.`,
      ).toBe(true)
    }
  })
})
