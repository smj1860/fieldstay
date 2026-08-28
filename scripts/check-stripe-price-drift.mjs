#!/usr/bin/env node
/**
 * FieldStay — Stripe price drift check.
 *
 * PLANS (lib/stripe/client.ts) is assumed to mirror every recurring price in
 * the Stripe account. Nothing enforced that, and the failure was silent in the
 * worst possible direction: handleCoreSubscriptionUpdate mapped an
 * unrecognised price with `getPlanByPriceId(id) ?? 'starter'`, so a price
 * Stripe knew about and PLANS did not rewrote a paying org to Starter /
 * max_properties 15.
 *
 * That specific consequence is fixed — an unmappable price now leaves the
 * entitlement columns alone and reports
 * `webhook.stripe.core-billing.unmapped-price` to Sentry. But that is
 * REACTIVE: you find out when a real customer's subscription event hits it.
 * This script is the proactive half — it fails the build when a recurring
 * price exists in Stripe that no PLANS entry claims.
 *
 * Deliberately dependency-free (plain fetch against Stripe's REST API), same
 * as the db-invariants scripts: a check that needs `npm install` to run is a
 * check that gets skipped.
 *
 * Self-disarms when STRIPE_SECRET_KEY is absent — forks and most PR runs
 * legitimately have no Stripe credentials. Set STRIPE_PRICE_DRIFT_REQUIRE_ARMED=1
 * to make an unarmed run a hard failure instead, the same escape hatch
 * check-db-invariants.mjs uses: on the canonical repo a silent skip is a green
 * check for something nobody verified.
 */

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
      'configured, so Stripe prices were NOT compared against PLANS.'
  )
  process.exit(0)
}

/**
 * Every price id the app legitimately knows about.
 *
 * Read from the environment rather than by importing lib/stripe/client.ts —
 * that module is TypeScript and pulls in the Stripe SDK, which would make this
 * script need a build step and a dependency install. The env var NAMES are the
 * contract either way.
 *
 * This comment used to claim env-schema-coverage.test.ts kept these two lists
 * and ENV_SPEC in sync. It did not — that test reads lib/env.ts and has never
 * looked at this file — and the Hosts tier proved it: STRIPE_PRICE_HOSTS_*
 * was added to ENV_SPEC, PLANS and the billing UI, and never here, so for the
 * whole life of the $89 tier its prices were checked by nothing and an active
 * Hosts price in Stripe would have been reported as drift. The claim is now
 * true because unit/guardrails/stripe-price-env-coverage.test.ts makes it
 * true.
 */
/**
 * Split into required and optional, because this script cannot otherwise tell
 * its two failure modes apart:
 *
 *   • Stripe has a price PLANS does not claim        → real drift, the point
 *   • we did not TELL the script about a price       → a config gap
 *
 * Both look identical from here — an id in Stripe with no env var pointing at
 * it — and the first run of this check hit the second one, reporting the three
 * live plan monthlies as drift and advising "add the price to PLANS" when they
 * were already in PLANS. That advice would have sent someone editing correct
 * code. An incomplete comparison must announce itself as incomplete rather
 * than dressing up as a finding.
 */
const REQUIRED_PRICE_ENV = [
  'STRIPE_PRICE_HOSTS_MONTHLY',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_GROWTH_MONTHLY',
  'STRIPE_PRICE_PORTFOLIO_MONTHLY',
  // Not a plan — the guidebook sponsor subscription. A legitimate recurring
  // price that PLANS deliberately does not claim, so it must be named here or
  // every run reports it as drift.
  'STRIPE_PRICE_SPONSOR_MONTHLY',
]

/**
 * Annual billing is not launched — no annual price exists in the Stripe
 * account, and PLANS' priceId() returns null for an unset var, which
 * createCheckoutSession already branches on. Unset is a supported state, so
 * these must not be required. If one IS set, it still gets compared, and the
 * dangling check below catches it pointing at a price that is not live.
 */
const OPTIONAL_PRICE_ENV = [
  'STRIPE_PRICE_HOSTS_ANNUAL',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_GROWTH_ANNUAL',
  'STRIPE_PRICE_PORTFOLIO_ANNUAL',
]

const readPrice = (name) => process.env[name]?.trim() || null

const missingRequired = REQUIRED_PRICE_ENV.filter((name) => !readPrice(name))

if (missingRequired.length > 0) {
  const detail =
    'Stripe price drift check cannot run: STRIPE_SECRET_KEY is set but these ' +
    `price variables are not — ${missingRequired.join(', ')}.\n\n` +
    'Without them the comparison is INCOMPLETE: every price they point at ' +
    'would be reported as drift even though PLANS claims it correctly. That ' +
    'is a CI configuration gap, not an application problem — do not go ' +
    'editing lib/stripe/client.ts on the strength of it.\n\n' +
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
    '\nActive recurring prices in Stripe that no PLANS entry claims:\n' +
      unmapped
        .map((p) => {
          const amount = p.unit_amount === null ? '(no unit_amount)' : `${p.unit_amount / 100} ${p.currency}`
          const every  = p.recurring ? `${p.recurring.interval_count} ${p.recurring.interval}` : '?'
          return `  • ${p.id}  ${amount} / ${every}  ${p.nickname ?? ''}`
        })
        .join('\n') +
      '\n\nA subscription on any of these resolves to no plan. That no longer ' +
      'downgrades the org (the entitlement columns are left alone and the ' +
      'event is reported), but the org also does not get the tier it is ' +
      'paying for.\n\n' +
      'Check FIRST whether the price is already in PLANS and simply has no ' +
      'env var configured here — that is a CI config gap, not drift, and the ' +
      'required-variable check above only covers the ids it knows to expect. ' +
      'If it is genuinely new: add it to PLANS in lib/stripe/client.ts with ' +
      'its env var and list that var in REQUIRED_PRICE_ENV, or — if it is ' +
      'deliberately not a plan, like the sponsor price — list it there ' +
      'without touching PLANS.'
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
//
// Reported separately from `dangling` rather than folded into it, because the
// remedy is different: a dangling id is fixed by repointing the env var, an
// inactive product is fixed in the Stripe dashboard with the env var already
// correct. Telling someone to change a value that is right sends them looking
// in the wrong place.
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

console.log(
  `Stripe prices and PLANS agree in both directions; ${known.size} configured ` +
    'price(s) are active and hang off an active product.'
)
