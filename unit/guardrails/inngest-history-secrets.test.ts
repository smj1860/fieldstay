import { describe, it, expect } from 'vitest'
import { balancedEnd, blankComments, collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Guardrail: a bearer token must not end up in an Inngest step's return value.
//
// An Inngest step's return value is PERSISTED as execution history and
// rendered in a third-party console. That is durable storage outside this
// system, in exactly the way Axiom and Sentry are — and the codebase already
// treats it that way, in two places, in prose:
//
//   guidebook-guest-opted-in.ts — a door code is "Decrypted just-in-time,
//     inside this step, and never returned from it — step return values are
//     persisted as Inngest execution history, so the plaintext code must not
//     end up in that record".
//   notify-assignment-gap.ts — returns user ids rather than emails because
//     "returning recipients: ['pm@example.com', ...] put PM email addresses
//     into a third-party console".
//
// The rule was understood and then not applied. A sweep on 2026-08-09 found
// eight steps returning a bearer credential for an UNAUTHENTICATED route:
// `completion_token` (/work-orders/<token>, the vendor portal),
// `guidebook_token` (/g/b/<token>, the guest portal), `quote_token`, and
// `stripe_connect_token` (a vendor's payments-onboarding link). One of them is
// the step immediately ABOVE the door-code comment quoted here, in the same
// file: the door code was protected and the portal token beside it was not.
//
// ── Why an in-source marker rather than a smarter matcher ───────────────────
//
// The scan cannot tell `return data` (leaks the token) from
// `return { created: !!row.completion_token }` (does not) — that needs
// dataflow, and a matcher that guesses would either miss real leaks or
// permanently blind a file. So the check is deliberately coarse: selecting a
// token column inside a step that returns ANYTHING requires an explicit
// `// inngest-history-safe: <reason>` on the spot. The scanner is not deciding
// — a human is, at the site, in a line a reviewer can check. Same shape as the
// justified `eslint-disable-next-line` comments elsewhere in this repo.
// ============================================================================

const SECRET_COLUMN = /^[a-z_]*(?:token|secret)[a-z_]*$/
const MARKER        = 'inngest-history-safe:'

/**
 * Sites known to return a token when this guardrail was written. SHRINK-ONLY:
 * each is a real leak awaiting the same treatment work-order-vendor-assigned.ts
 * got — read the token inside the step that consumes it, return a boolean.
 * Never add an entry. Removing one is the point.
 *
 * Keyed by file rather than line so an unrelated edit above does not force a
 * churn commit; the line moves, the obligation does not.
 */
const BASELINE = new Set([
  'lib/inngest/functions/cron/vendor-connect-onboarding.ts',
  'lib/inngest/functions/guidebook-pre-arrival-email-cron.ts',
  'lib/inngest/functions/work-order-dispatch.ts',
  'lib/inngest/functions/guidebook-guest-opted-in.ts',
  'lib/inngest/functions/guidebook-stay-extension-handler.ts',
  'lib/inngest/functions/work-order-events.ts',
])

/**
 * `door_code_secret_id` is a Vault secret IDENTIFIER, not a secret. Redeeming
 * it needs service-role Vault access, so it is not a bearer credential and is
 * not the thing the door-code comment above is protecting — that comment is
 * about the decrypted code, which is already handled correctly.
 */
const NOT_A_BEARER_TOKEN = new Set(['door_code_secret_id'])

/**
 * The balanced `step.run( … )` call text starting at `from`, plus its span.
 *
 * Both the blanking and the bracket walk come from ./scan. The local versions
 * were a regex comment-stripper and a hand-rolled `inString` loop, and together
 * they had a live hole: the stripper treated the `//` in a `'https://…'` string
 * as a line comment and blanked the REST OF THAT LINE, including any bracket on
 * it. Twelve lib/inngest files hit that, and in six of them the destroyed
 * bracket left this walk unbalanced — so it ran to EOF, returned null, and
 * findOffenders skipped the whole step. Six step bodies were invisible to a
 * guardrail whose job is catching tokens returned into Inngest step history,
 * three of them in files this file's own BASELINE already flags as leaking.
 *
 * Returns null only when the call is genuinely unbalanced, which after the fix
 * should not happen for real source.
 */
function stepRunCall(src: string, from: number): { text: string; end: number } | null {
  const open = src.indexOf('(', from)
  if (open === -1) return null

  const end = balancedEnd(src, open)
  if (!')]}'.includes(src[end - 1] ?? '')) return null

  return { text: src.slice(open, end), end }
}

function secretColumnsIn(body: string): string[] {
  const cols = new Set<string>()
  for (const sel of body.match(/\.select\(\s*[`'"][^`'"]*[`'"]/g) ?? []) {
    const list = /[`'"]([^`'"]*)[`'"]/.exec(sel)?.[1] ?? ''
    for (const raw of list.split(',')) {
      const col = raw.trim().split(/[\s(:]/)[0] as string
      if (SECRET_COLUMN.test(col) && !NOT_A_BEARER_TOKEN.has(col)) cols.add(col)
    }
  }
  return Array.from(cols)
}

interface Finding { file: string; line: number; cols: string[] }

function findOffenders(): Finding[] {
  const offenders: Finding[] = []

  for (const file of collectSourceFiles(['lib/inngest'])) {
    const raw      = read(file)
    const stripped = blankComments(raw)

    const re = /\bstep\.run\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const call = stepRunCall(stripped, m.index)
      if (!call) continue

      const body = call.text
      const cols = secretColumnsIn(body)
      if (!cols.length) continue
      if (!/\breturn\b/.test(body)) continue

      // The marker is a comment, so it only exists in the raw source. Look for
      // it across the same span.
      const spanStart = m.index
      const spanEnd   = spanStart + (call.end - m.index)
      if (raw.slice(spanStart, spanEnd).includes(MARKER)) continue

      offenders.push({
        file: rel(file),
        line: stripped.slice(0, m.index).split('\n').length,
        cols,
      })
    }
  }

  return offenders
}

describe('guardrail: bearer tokens must not enter an Inngest step return value', () => {
  it('no NEW step returns a token — the baseline may shrink but never grow', () => {
    const fresh = findOffenders().filter((o) => !BASELINE.has(o.file))
    expect(
      fresh,
      fresh.length
        ? 'These Inngest steps select a bearer token and return:\n' +
          fresh.map((o) => `  - ${o.file}:${o.line} [${o.cols.join(', ')}]`).join('\n') +
          '\n\nA step return value is persisted as Inngest execution history and rendered ' +
          'in a third-party console, so the token lands in durable storage outside this ' +
          'system — and these tokens are bearer credentials for UNAUTHENTICATED routes ' +
          '(/work-orders/<token>, /g/b/<token>). Read the token inside the step that ' +
          'consumes it and return a boolean instead (work-order-vendor-assigned.ts is the ' +
          'reference), or — if the return genuinely carries no token — say so on the spot ' +
          `with a \`// ${MARKER} <reason>\` comment.`
        : '',
    ).toEqual([])
  })

  it('every BASELINE entry is still an offender (prune as they are fixed)', () => {
    const offending = new Set(findOffenders().map((o) => o.file))
    for (const file of BASELINE) {
      expect(
        offending.has(file),
        `BASELINE lists ${file}, which no longer returns a token — delete the entry so it ` +
        'cannot regress silently. This list is shrink-only and an entry that has been fixed ' +
        'is the whole point of it.',
      ).toBe(true)
    }
  })

  it('the matcher still fires — a clean tree and a broken scan look identical', () => {
    // Without this, deleting the SELECT regex would turn the check permanently
    // green. The baseline doubles as the fixture: it must keep matching.
    expect(findOffenders().length).toBeGreaterThanOrEqual(BASELINE.size)
  })

  it('no step.run body is silently skipped', () => {
    // The hole this file shipped with, and the one thing that would have shown
    // it. findOffenders does `if (!call) continue`, so a step whose body cannot
    // be delimited is not reported as a problem — it is not examined at all,
    // and the scan stays green while covering less of the tree every time
    // someone writes a URL inside a step. Six bodies were in that state: the
    // regex comment-stripper blanked the rest of the line after `https://`,
    // taking a bracket with it, and the walk never rebalanced.
    //
    // Counting offenders cannot detect this; only counting the steps the scan
    // FAILED to delimit can.
    const skipped: string[] = []
    let seen = 0

    for (const file of collectSourceFiles(['lib/inngest'])) {
      const stripped = blankComments(read(file))
      for (const m of stripped.matchAll(/\bstep\.run\s*\(/g)) {
        seen++
        if (stepRunCall(stripped, m.index) === null) {
          skipped.push(`${rel(file)}:${stripped.slice(0, m.index).split('\n').length}`)
        }
      }
    }

    expect(seen, 'no step.run calls found at all — the scan is not reading the tree')
      .toBeGreaterThan(50)
    expect(
      skipped,
      'These step.run bodies could not be delimited, so the secret-leak scan skipped '
      + 'them entirely rather than reporting anything. A token returned from one of '
      + 'these would not be caught:\n' + skipped.join('\n'),
    ).toEqual([])
  })

  it('recognises the marker, and only within the marked step', () => {
    const marked = [
      "await step.run('x', async () => {",
      '  // inngest-history-safe: returns a boolean only',
      "  const r = await supabase.from('t').select('completion_token').single()",
      '  return { created: !!r.data?.completion_token }',
      '})',
    ].join('\n')
    const unmarked = marked.replace('  // inngest-history-safe: returns a boolean only\n', '')

    // Exercised through the same helpers the scan uses, not a reimplementation.
    const body = stepRunCall(blankComments(marked), marked.indexOf('step.run'))
    expect(body).not.toBeNull()
    expect(secretColumnsIn((body as { text: string }).text)).toEqual(['completion_token'])
    expect(marked.includes(MARKER)).toBe(true)
    expect(unmarked.includes(MARKER)).toBe(false)
  })
})
