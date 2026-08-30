import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'node:fs'
import { read, readCode, ROOT } from './scan'
import { ENV_SPEC } from '../../lib/env'
import { BRACKETS, ANNUAL_MULTIPLIER, toStripeTiers } from '../../lib/stripe/brackets'

// ============================================================================
// Every STRIPE_PRICE_* variable the app declares is actually CHECKED against
// Stripe, and is actually PASSED to the check by CI.
//
// scripts/check-stripe-price-drift.mjs verifies, in both directions, that the
// price ids we configure and the prices that exist in Stripe agree. It is
// dependency-free by design and therefore reads the variable NAMES from two
// hand-written arrays rather than importing lib/env.ts, and reads the
// graduated bracket schedule out of lib/stripe/brackets.ts's SOURCE (regex,
// not import) for the same reason. Rewritten 2026-08-29 for the
// graduated-pricing rebuild — 8 flat-tier price vars collapsed to 2, plus a
// NEW check the flat model never needed: that the live Stripe Price's `tiers`
// array actually matches the schedule this codebase decided on.
//
// Three things have to line up for the id/product checks to mean anything,
// and a break in any one of them is invisible on a green run:
//
//   1. ENV_SPEC → script:   every declared price var appears in one of the two
//      arrays, so it is compared at all.
//   2. script → ENV_SPEC:   no array names a variable the app does not declare
//      (a typo'd name silently reads as "unset", which the REQUIRED list
//      reports as an incomplete run and the OPTIONAL list ignores entirely).
//   3. script → CI:         the workflow actually passes each one through, or
//      the armed run sees `undefined` and the comparison is incomplete. This
//      is not theoretical either — the script's own history records a first
//      armed run that saw one of seven and reported three live prices as
//      drift.
//
// A fourth thing matters only for the graduated model: the script's own
// bracket-schedule EXTRACTION must actually work against the real file. A
// broken regex and a genuinely-matching schedule both read as "no shape
// errors" if the extraction throws and nothing catches it — so this file
// also runs the script's extraction logic against the real brackets.ts and
// asserts it returns the same numbers `import`ing the module does.
// ============================================================================

const SCRIPT = join(ROOT, 'scripts/check-stripe-price-drift.mjs')
const CI     = join(ROOT, '.github/workflows/ci.yml')

/** Names in one of the script's two arrays. Comments stripped, so a name that
 *  only appears in prose does not count as coverage — the exact way a scanner
 *  reads its own documentation as a pass. */
function scriptPriceVars(): { required: Set<string>; optional: Set<string> } {
  // readCode, not read: the arrays carry explanatory comments INSIDE the
  // brackets, and one of them names STRIPE_PRICE_SPONSOR_MONTHLY in prose. A
  // raw read would count that mention as an entry — a guardrail satisfied by
  // its own documentation.
  const src = readCode(SCRIPT)

  const arrayBody = (name: string): string => {
    const start = src.indexOf(`const ${name} = [`)
    expect(start, `${name} not found in ${SCRIPT}`).toBeGreaterThan(-1)
    const end = src.indexOf(']', start)
    expect(end, `${name} array is unterminated`).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  const names = (body: string) =>
    new Set(
      // Only quoted string entries count. A bare mention inside the array's
      // comment block is not an entry, and this is an array of literals so
      // there is no legitimate unquoted form to miss.
      [...body.matchAll(/['"](STRIPE_PRICE_[A-Z_]+)['"]/g)].map((m) => m[1]!),
    )

  return {
    required: names(arrayBody('REQUIRED_PRICE_ENV')),
    optional: names(arrayBody('OPTIONAL_PRICE_ENV')),
  }
}

/**
 * Price vars the app declares.
 *
 * SPONSOR_MONTHLY is included deliberately: it is not the platform price, but
 * it is a real recurring price, and if the script does not know about it
 * every run reports it as drift. The script says as much in its own comment.
 */
const declared = Object.keys(ENV_SPEC)
  .filter((n) => n.startsWith('STRIPE_PRICE_'))
  .sort()

describe('Stripe price env coverage', () => {
  it('declares exactly the platform price (both intervals) plus the sponsor price', () => {
    // The control. Every assertion below is a set comparison, and two empty
    // sets agree perfectly — a broken ENV_SPEC read would pass the whole file.
    expect(declared).toEqual([
      'STRIPE_PRICE_PLATFORM_ANNUAL',
      'STRIPE_PRICE_PLATFORM_MONTHLY',
      'STRIPE_PRICE_SPONSOR_MONTHLY',
    ])
  })

  it('checks every declared price variable against Stripe', () => {
    const { required, optional } = scriptPriceVars()
    const covered = new Set([...required, ...optional])

    const unchecked = declared.filter((n) => !covered.has(n))

    expect(
      unchecked,
      `These STRIPE_PRICE_* variables are declared in lib/env.ts but appear in ` +
        `neither REQUIRED_PRICE_ENV nor OPTIONAL_PRICE_ENV in ` +
        `scripts/check-stripe-price-drift.mjs, so the price ids they hold are ` +
        `compared against Stripe by nothing.`,
    ).toEqual([])
  })

  it('names no variable the app does not declare', () => {
    const { required, optional } = scriptPriceVars()
    const declaredSet = new Set(declared)

    const unknown = [...required, ...optional].filter((n) => !declaredSet.has(n)).sort()

    expect(
      unknown,
      `scripts/check-stripe-price-drift.mjs expects these variables, but ` +
        `lib/env.ts does not declare them. A name that matches nothing reads ` +
        `as unset: in REQUIRED_PRICE_ENV that aborts the comparison as ` +
        `"incomplete", and in OPTIONAL_PRICE_ENV it is skipped in silence.`,
    ).toEqual([])
  })

  it('passes every checked variable through in the CI job', () => {
    const { required, optional } = scriptPriceVars()
    const ci = read(CI)

    // The workflow's env block writes each as `NAME: ${{ ... }}`. Matching the
    // name followed by a colon is enough to distinguish a real binding from
    // the several places these are discussed in that file's comments.
    const missing = [...required, ...optional]
      .filter((n) => !new RegExp(`^\\s*${n}:`, 'm').test(ci))
      .sort()

    expect(
      missing,
      `These price variables are checked by ` +
        `scripts/check-stripe-price-drift.mjs but are not passed to it by the ` +
        `db-invariants job in .github/workflows/ci.yml, so an ARMED run reads ` +
        `them as undefined. A required one turns the whole run into a warned ` +
        `skip; an optional one is silently not compared.`,
    ).toEqual([])
  })

  it('verifies the PRODUCT behind each price, not just the price', () => {
    // The defect that put this file here. `GET /v1/prices?active=true` filters
    // on price.active, and archiving a product in the Stripe dashboard leaves
    // price.active = true — so an unpurchasable price passed every check the
    // script had. Asserting the expand is present is asserting there is
    // anything to test: without it `p.product` is a bare id string.
    const src = readCode(SCRIPT)
    expect(src).toContain("qs.append('expand[]', 'data.product')")
    expect(src).toMatch(/product\.active === false/)
  })

  it('checks both platform price env vars against the graduated bracket schedule, not just id/product', () => {
    const src = readCode(SCRIPT)
    expect(src).toContain('PLATFORM_PRICE_ENV')
    expect(src).toMatch(/billing_scheme !== 'tiered'/)
    expect(src).toMatch(/tiers_mode !== 'graduated'/)
  })

  describe('the script\'s bracket-schedule extraction', () => {
    // A broken regex and a genuinely-matching schedule both read as "no shape
    // errors" upstream if this extraction silently returns nothing — so this
    // runs the extraction the script itself uses (copied here rather than
    // imported, since the script is a standalone .mjs with no exports) against
    // the REAL lib/stripe/brackets.ts and checks it against what importing the
    // module directly gives us.
    function readBracketScheduleFromSource(): { annualMultiplier: number; brackets: unknown[] } {
      const src = readFileSync(join(ROOT, 'lib/stripe/brackets.ts'), 'utf8')

      const multiplierMatch = /export const ANNUAL_MULTIPLIER = (\d+)/.exec(src)
      expect(multiplierMatch, 'ANNUAL_MULTIPLIER not found by the script\'s regex').not.toBeNull()

      const arrayMatch = /export const BRACKETS: readonly Bracket\[\] = \[([\s\S]*?)\n\] as const/.exec(src)
      expect(arrayMatch, 'BRACKETS array not found by the script\'s regex').not.toBeNull()

      const entryPattern = /\{\s*upTo:\s*(\d+),\s*(flatAmountCents|unitAmountCents):\s*(\d[\d_]*)\s*\}/g
      const brackets: unknown[] = []
      let m: RegExpExecArray | null
      while ((m = entryPattern.exec(arrayMatch![1]!)) !== null) {
        const upTo = Number(m[1])
        const amountCents = Number(m[3]!.replaceAll('_', ''))
        brackets.push(m[2] === 'flatAmountCents' ? { upTo, flatAmountCents: amountCents } : { upTo, unitAmountCents: amountCents })
      }

      return { annualMultiplier: Number(multiplierMatch![1]), brackets }
    }

    it('extracts ANNUAL_MULTIPLIER matching the real export', () => {
      const { annualMultiplier } = readBracketScheduleFromSource()
      expect(annualMultiplier).toBe(ANNUAL_MULTIPLIER)
    })

    it('extracts every bracket matching the real BRACKETS array', () => {
      const { brackets } = readBracketScheduleFromSource()
      expect(brackets).toEqual(BRACKETS)
    })

    it('produces the same monthly and annual tiers as toStripeTiers()', () => {
      const { annualMultiplier, brackets } = readBracketScheduleFromSource()
      const typedBrackets = brackets as { upTo: number; flatAmountCents?: number; unitAmountCents?: number }[]
      // The last tier's up_to is 'inf', not a number — Stripe rejects a
      // graduated tiers array whose last element isn't the 'inf' catch-all.
      const toTiers = (multiplier: number) =>
        typedBrackets.map((b, i) => ({
          up_to: i === typedBrackets.length - 1 ? 'inf' : b.upTo,
          ...(b.flatAmountCents !== undefined
            ? { flat_amount: b.flatAmountCents * multiplier }
            : { unit_amount: b.unitAmountCents! * multiplier }),
        }))

      expect(toTiers(1)).toEqual(toStripeTiers('monthly'))
      expect(toTiers(annualMultiplier)).toEqual(toStripeTiers('annual'))
    })
  })
})
