#!/usr/bin/env node
/**
 * FieldStay — Stripe price drift check.
 *
 * Rewritten 2026-08-29 for the graduated-pricing rebuild. The old version
 * compared a flat set of price ids/amounts against PLANS (lib/stripe/
 * client.ts's 4-tier map). PLANS is gone — every self-serve org now sits on
 * ONE graduated (billing_scheme: 'tiered', tiers_mode: 'graduated') price per
 * interval, so a 1:1 id/amount comparison no longer means anything. This
 * version checks TWO different things:
 *
 *   1. The usual dangling/inactive-product checks (unchanged in spirit) for
 *      every configured price id, including the unrelated sponsor price.
 *   2. For the platform price(s) specifically: that the LIVE Stripe Price is
 *      actually shaped as `billing_scheme: 'tiered'`, `tiers_mode:
 *      'graduated'`, and that its `tiers` array matches — exactly, amount for
 *      amount — the schedule in lib/stripe/brackets.ts. A dashboard edit that
 *      changes a bracket rate, or a price that silently reverted to a flat
 *      `unit_amount`, would otherwise bill real customers a number this
 *      codebase never decided on.
 *
 * The bracket schedule is read out of lib/stripe/brackets.ts's SOURCE via
 * regex rather than imported, for the same reason the rest of this file reads
 * env vars as plain text: this script is deliberately dependency-free (plain
 * fetch, no TS, no build step) so a check that needs `npm install` is not a
 * check that gets skipped. There is exactly one BRACKETS literal in the repo,
 * and unit/guardrails/stripe-price-env-coverage.test.ts's tiers-shape test
 * exercises this same extraction so a change to the array's formatting fails
 * loud in CI rather than silently starting to pass everything.
 *
 * Deliberately dependency-free (plain fetch against Stripe's REST API), same
 * as the db-invariants scripts.
 *
 * Self-disarms when STRIPE_SECRET_KEY is absent — forks and most PR runs
 * legitimately have no Stripe credentials. Set STRIPE_PRICE_DRIFT_REQUIRE_ARMED=1
 * to make an unarmed run a hard failure instead, the same escape hatch
 * check-db-invariants.mjs uses: on the canonical repo a silent skip is a green
 * check for something nobody verified.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const key = process.env.STRIPE_SECRET_KEY

if (!key) {
  if (process.env.STRIPE_PRICE_DRIFT_REQUIRE_ARMED === '1') {
    console.error(
      'Stripe price drift gate is REQUIRED on this run but UNARMED: ' +
        'STRIPE_SECRET_KEY is not set. Passing here would report a green ' +
        'check for a comparison nobody made.'
    )
    process.exit(1)
  }
  console.log(
    '::warning title=Stripe price drift gate UNARMED::STRIPE_SECRET_KEY is not ' +
      'configured, so Stripe prices were NOT compared against the graduated schedule.'
  )
  process.exit(0)
}

/**
 * Every price id the app legitimately knows about, split into required and
 * optional for the same reason as before: this script cannot otherwise tell
 * "a real price Stripe has that we forgot to name" apart from "a config gap
 * where we just never told the script about it" — both look identical as an
 * id in Stripe with no env var pointing at it.
 */
const REQUIRED_PRICE_ENV = [
  'STRIPE_PRICE_PLATFORM_MONTHLY',
  'STRIPE_PRICE_PLATFORM_ANNUAL',
  // Not the platform price — the guidebook sponsor subscription. A legitimate
  // recurring price this schedule deliberately does not claim, so it must be
  // named here or every run reports it as drift.
  'STRIPE_PRICE_SPONSOR_MONTHLY',
]

const OPTIONAL_PRICE_ENV = []

/** Env vars whose price must match the graduated bracket schedule exactly. */
const PLATFORM_PRICE_ENV = new Map([
  ['STRIPE_PRICE_PLATFORM_MONTHLY', 'monthly'],
  ['STRIPE_PRICE_PLATFORM_ANNUAL',  'annual'],
])

const readPrice = (name) => process.env[name]?.trim() || null

const missingRequired = REQUIRED_PRICE_ENV.filter((name) => !readPrice(name))

if (missingRequired.length > 0) {
  const detail =
    'Stripe price drift check cannot run: STRIPE_SECRET_KEY is set but these ' +
    `price variables are not — ${missingRequired.join(', ')}.\n\n` +
    'Without them the comparison is INCOMPLETE: every price they point at ' +
    'would be reported as drift even though the schedule claims it correctly. ' +
    'That is a CI configuration gap, not an application problem — do not go ' +
    'editing lib/stripe/brackets.ts on the strength of it.\n\n' +
    'Fix by adding the missing ids as repo secrets (they are the same values ' +
    'the deployed app already uses), then set the repo variable ' +
    'STRIPE_PRICE_DRIFT_ARMED=1 to turn this into a hard gate.'

  if (process.env.STRIPE_PRICE_DRIFT_REQUIRE_ARMED === '1') {
    console.error(detail)
    process.exit(1)
  }
  console.log(`::warning title=Stripe price drift gate INCOMPLETE::${detail.replace(/\n+/g, ' ')}`)
  process.exit(0)
}

const known = new Map()
for (const name of [...REQUIRED_PRICE_ENV, ...OPTIONAL_PRICE_ENV]) {
  const value = readPrice(name)
  if (value) known.set(value, name)
}

// ── The bracket schedule, extracted from its one real source ────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Pulls the locked bracket schedule out of lib/stripe/brackets.ts's literal
 * `BRACKETS` array and `ANNUAL_MULTIPLIER` constant. Throws (loudly, not a
 * silent pass) if the shape has changed enough that the regex can no longer
 * find them — the self-check test asserts this extraction actually works
 * against the real file.
 */
function readBracketSchedule() {
  const src = readFileSync(join(__dirname, '..', 'lib', 'stripe', 'brackets.ts'), 'utf8')

  const multiplierMatch = /export const ANNUAL_MULTIPLIER = (\d+)/.exec(src)
  if (!multiplierMatch) throw new Error('Could not find ANNUAL_MULTIPLIER in lib/stripe/brackets.ts')
  const annualMultiplier = Number(multiplierMatch[1])

  const arrayMatch = /export const BRACKETS: readonly Bracket\[\] = \[([\s\S]*?)\n\] as const/.exec(src)
  if (!arrayMatch) throw new Error('Could not find the BRACKETS array in lib/stripe/brackets.ts')

  const entryPattern = /\{\s*upTo:\s*(\d+),\s*(flatAmountCents|unitAmountCents):\s*(\d[\d_]*)\s*\}/g
  const brackets = []
  let m
  while ((m = entryPattern.exec(arrayMatch[1])) !== null) {
    const upTo = Number(m[1])
    const amountCents = Number(m[3].replaceAll('_', ''))
    brackets.push(m[2] === 'flatAmountCents' ? { upTo, flatAmountCents: amountCents } : { upTo, unitAmountCents: amountCents })
  }

  if (brackets.length === 0) throw new Error('BRACKETS array matched but no bracket entries were parsed')

  return { annualMultiplier, brackets }
}

/**
 * Mirrors lib/stripe/brackets.ts's toStripeTiers() exactly — including the
 * last tier's `up_to` being the literal string 'inf', not a number. Stripe
 * rejects a graduated `tiers` array whose last element isn't the 'inf'
 * catch-all, and returns it back as `up_to: null` on every read — see that
 * function's header comment for how this was actually discovered.
 */
function toStripeTiers(brackets, multiplier) {
  return brackets.map((b, i) => ({
    up_to: i === brackets.length - 1 ? 'inf' : b.upTo,
    ...(b.flatAmountCents !== undefined
      ? { flat_amount: b.flatAmountCents * multiplier }
      : { unit_amount: b.unitAmountCents * multiplier }),
  }))
}

function tiersEqual(a, b) {
  if (a.length !== b.length) return false
  return a.every((tier, i) =>
    tier.up_to === b[i].up_to
    && tier.flat_amount === b[i].flat_amount
    && tier.unit_amount === b[i].unit_amount,
  )
}

async function stripeGet(path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal:  AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Stripe GET /v1/${path} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

/**
 * All active recurring prices, following Stripe's cursor pagination.
 *
 * `expand[]=data.product` is load-bearing, not a convenience — see the
 * product-active check at the bottom of this file. Without it `p.product` is a
 * bare id string and there is nothing to test.
 */
async function listActiveRecurringPrices() {
  const out = []
  let startingAfter = null

  for (;;) {
    const qs = new URLSearchParams({ active: 'true', type: 'recurring', limit: '100' })
    qs.append('expand[]', 'data.product')
    if (startingAfter) qs.set('starting_after', startingAfter)

    const page = await stripeGet(`prices?${qs}`)
    out.push(...page.data)

    // `has_more` is the only termination signal Stripe gives; a short page is
    // NOT one, so this cannot be written as "stop when fewer than 100".
    if (!page.has_more || page.data.length === 0) return out
    startingAfter = page.data[page.data.length - 1].id
  }
}

const prices = await listActiveRecurringPrices()
const unmapped = prices.filter((p) => !known.has(p.id))

console.log(
  `Stripe price drift: ${prices.length} active recurring price(s), ` +
    `${known.size} mapped by env, ${unmapped.length} unmapped.`
)

if (unmapped.length > 0) {
  console.error(
    '\nActive recurring prices in Stripe that no configured env var claims:\n' +
      unmapped
        .map((p) => {
          const amount = p.unit_amount === null ? '(no unit_amount — likely tiered)' : `${p.unit_amount / 100} ${p.currency}`
          const every  = p.recurring ? `${p.recurring.interval_count} ${p.recurring.interval}` : '?'
          return `  • ${p.id}  ${amount} / ${every}  ${p.nickname ?? ''}`
        })
        .join('\n') +
      '\n\nA subscription on any of these resolves as an unrecognized platform ' +
      'price (core-billing.ts syncs status only, entitlement columns untouched) ' +
      'or is entirely invisible if it is not core billing at all.\n\n' +
      'Check FIRST whether the price is already configured and simply missing ' +
      'from REQUIRED_PRICE_ENV/PLATFORM_PRICE_ENV in this script — that is a CI ' +
      'config gap, not drift. If it is genuinely new: list its env var above.'
  )
  process.exit(1)
}

// The other direction: an env var pointing at a price that no longer exists,
// or is archived. Checkout would fail with an opaque "No such price".
const liveIds = new Set(prices.map((p) => p.id))
const dangling = [...known.entries()].filter(([id]) => !liveIds.has(id))

if (dangling.length > 0) {
  console.error(
    '\nConfigured price ids that are not an ACTIVE recurring price in Stripe ' +
      '(archived, deleted, or from another account):\n' +
      dangling.map(([id, envName]) => `  • ${envName} = ${id}`).join('\n') +
      '\n\nCheckout against one of these fails with an opaque "No such price".'
  )
  process.exit(1)
}

// A price can be ACTIVE and still be unpurchasable, because purchasability is
// a property of the PRODUCT it hangs off. Archiving a product in the Stripe
// dashboard sets product.active = false and leaves price.active = true, so
// such a price is returned by `GET /v1/prices?active=true`, lands in liveIds,
// and sails through the dangling check above. Everything here was green.
//
// This is not hypothetical. On 2026-08-28 a checkout in production failed with
//   Price `price_…` is not available to be purchased because its product is
//   not active
// — a message that only exists for this exact state, and that proves the price
// itself resolved fine. This check is the half that was missing.
const inactiveProduct = prices
  .filter((p) => known.has(p.id))
  .map((p) => ({ price: p, product: typeof p.product === 'object' ? p.product : null }))
  .filter(({ product }) => product !== null && product.active === false)

if (inactiveProduct.length > 0) {
  console.error(
    '\nConfigured price ids whose Stripe PRODUCT is archived (the price itself ' +
      'is active, which is why this reads as fine everywhere else):\n' +
      inactiveProduct
        .map(({ price, product }) =>
          `  • ${known.get(price.id)} = ${price.id}  →  product ${product.id} ` +
          `(${product.name ?? 'unnamed'}) is not active`)
        .join('\n') +
      '\n\nCheckout against one of these fails at ' +
      'stripe.checkout.sessions.create — the customer gets a generic error at ' +
      'the moment they try to pay, and no session is ever created.\n\n' +
      'Fix in the Stripe dashboard: un-archive the product (Product catalogue → ' +
      'the product → Unarchive). The price id does not change, so nothing in ' +
      'Vercel needs editing.'
  )
  process.exit(1)
}

// An id we could not expand is not a pass. Silence here would mean the check
// above compared nothing — the failure mode this whole file exists to avoid.
const unexpandable = prices.filter((p) => known.has(p.id) && typeof p.product !== 'object')
if (unexpandable.length > 0) {
  console.error(
    `\n${unexpandable.length} configured price(s) came back without an expanded ` +
      'product, so their product status was NOT checked. Stripe may have ' +
      'changed how `expand[]=data.product` behaves on list endpoints.'
  )
  process.exit(1)
}

// ── The graduated-pricing-specific check ─────────────────────────────────────
// A dashboard edit changing a bracket rate, or a price that silently reverted
// to a flat unit_amount, would sail through every check above (still active,
// still hangs off an active product) while billing real customers a schedule
// this codebase never decided on.
const { annualMultiplier, brackets } = readBracketSchedule()
const pricesById = new Map(prices.map((p) => [p.id, p]))

const shapeErrors = []
for (const [envName, interval] of PLATFORM_PRICE_ENV) {
  const id = readPrice(envName)
  if (!id) continue // already reported as missing above if required
  const price = pricesById.get(id)
  if (!price) continue // already reported as dangling above

  if (price.billing_scheme !== 'tiered' || price.tiers_mode !== 'graduated') {
    shapeErrors.push(
      `  • ${envName} = ${id}: billing_scheme=${price.billing_scheme}, ` +
      `tiers_mode=${price.tiers_mode ?? '(none)'} — expected tiered/graduated`,
    )
    continue
  }

  const expected = toStripeTiers(brackets, interval === 'annual' ? annualMultiplier : 1)
  // Stripe's own read API returns the catch-all tier's up_to as `null`, not
  // the 'inf' it was created with — normalize so the comparison below isn't
  // comparing 'inf' against null on every single price, forever.
  const actual = (price.tiers ?? []).map((t) => ({
    up_to: t.up_to ?? 'inf',
    flat_amount: t.flat_amount ?? undefined,
    unit_amount: t.unit_amount ?? undefined,
  }))

  if (!tiersEqual(expected, actual)) {
    shapeErrors.push(
      `  • ${envName} = ${id}: live tiers do not match lib/stripe/brackets.ts\n` +
      `      expected: ${JSON.stringify(expected)}\n` +
      `      actual:   ${JSON.stringify(actual)}`,
    )
  }
}

if (shapeErrors.length > 0) {
  console.error(
    '\nConfigured platform price(s) do not match the graduated bracket schedule ' +
      '(lib/stripe/brackets.ts):\n' + shapeErrors.join('\n') +
      '\n\nA customer checking out or being reconciled against this price is ' +
      'billed a schedule this codebase never decided on. Fix the Stripe Price ' +
      '(prices are immutable once created — you likely need a NEW Price with ' +
      'the correct tiers, then repoint the env var) or, if the schedule was ' +
      'deliberately changed, update lib/stripe/brackets.ts to match and expect ' +
      'a full re-review — that schedule was tuned against specific revenue math.'
  )
  process.exit(1)
}

console.log(
  `Stripe prices and the graduated schedule agree in both directions; ${known.size} ` +
    'configured price(s) are active, hang off an active product, and (for the ' +
    'platform price) match the locked bracket schedule.'
)
