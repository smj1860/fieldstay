import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { read, readCode, ROOT } from './scan'
import { ENV_SPEC } from '../../lib/env'

// ============================================================================
// Every STRIPE_PRICE_* variable the app declares is actually CHECKED against
// Stripe, and is actually PASSED to the check by CI.
//
// scripts/check-stripe-price-drift.mjs verifies, in both directions, that the
// price ids we configure and the prices that exist in Stripe agree. It is
// dependency-free by design and therefore reads the variable NAMES from two
// hand-written arrays rather than importing lib/env.ts. Its own comment used
// to assert that env-schema-coverage.test.ts kept those arrays in sync with
// ENV_SPEC. That was never true: that test reads lib/env.ts and has never
// looked at this script.
//
// The gap was live. The $89 Hosts tier shipped with STRIPE_PRICE_HOSTS_MONTHLY
// and _ANNUAL added to ENV_SPEC, to PLANS in lib/stripe/client.ts, and to the
// billing UI's plan cards — and to neither array here nor to the CI job's env
// block. So the two prices behind a purchasable plan were compared against
// nothing, and had a Hosts price been live in Stripe the script would have
// reported it as DRIFT and told someone to add a plan that already existed.
//
// Three things have to line up for the check to mean anything, and a break in
// any one of them is invisible on a green run:
//
//   1. ENV_SPEC → script:   every declared price var appears in one of the two
//      arrays, so it is compared at all.
//   2. script → ENV_SPEC:   no array names a variable the app does not declare
//      (a typo'd name silently reads as "unset", which the REQUIRED list
//      reports as an incomplete run and the OPTIONAL list ignores entirely).
//   3. script → CI:         the workflow actually passes each one through, or
//      the armed run sees `undefined` and the comparison is incomplete. This
//      is not theoretical either — the script's own comment records a first
//      armed run that saw one of seven and reported three live prices as
//      drift.
// ============================================================================

const SCRIPT = join(ROOT, 'scripts/check-stripe-price-drift.mjs')
const CI     = join(ROOT, '.github/workflows/ci.yml')

/** Names in one of the script's two arrays. Comments stripped, so a name that
 *  only appears in prose does not count as coverage — the exact way a scanner
 *  reads its own documentation as a pass. */
function scriptPriceVars(): { required: Set<string>; optional: Set<string> } {
  // readCode, not read: both arrays carry explanatory comments INSIDE the
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
 * SPONSOR_MONTHLY is included deliberately: it is not a PLANS tier, but it is
 * a real recurring price, and if the script does not know about it every run
 * reports it as drift. The script says as much in its own comment.
 */
const declared = Object.keys(ENV_SPEC)
  .filter((n) => n.startsWith('STRIPE_PRICE_'))
  .sort()

describe('Stripe price env coverage', () => {
  it('declares at least the four plan tiers plus the sponsor price', () => {
    // The control. Every assertion below is a set comparison, and two empty
    // sets agree perfectly — a broken ENV_SPEC read would pass the whole file.
    expect(declared.length).toBeGreaterThanOrEqual(9)
    expect(declared).toContain('STRIPE_PRICE_HOSTS_MONTHLY')
    expect(declared).toContain('STRIPE_PRICE_SPONSOR_MONTHLY')
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
        `compared against Stripe by nothing. A monthly price for a plan the ` +
        `billing UI sells belongs in REQUIRED_PRICE_ENV; an annual price that ` +
        `may legitimately be unset belongs in OPTIONAL_PRICE_ENV.`,
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
})
