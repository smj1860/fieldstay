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
 * contract either way; unit/guardrails/env-schema-coverage.test.ts is what
 * keeps this list and ENV_SPEC from drifting apart.
 */
const KNOWN_PRICE_ENV = [
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_GROWTH_MONTHLY',
  'STRIPE_PRICE_GROWTH_ANNUAL',
  'STRIPE_PRICE_PORTFOLIO_MONTHLY',
  'STRIPE_PRICE_PORTFOLIO_ANNUAL',
  // Not a plan — the guidebook sponsor subscription. It is a legitimate
  // recurring price that PLANS deliberately does not claim, so it must be
  // named here or every run reports it as drift.
  'STRIPE_PRICE_SPONSOR_MONTHLY',
]

const known = new Map()
for (const name of KNOWN_PRICE_ENV) {
  const value = process.env[name]
  if (value?.trim()) known.set(value.trim(), name)
}

if (known.size === 0) {
  console.error(
    'No STRIPE_PRICE_* variables are set, so every price in the account would ' +
      'report as drift. Configure them, or leave STRIPE_SECRET_KEY unset to ' +
      'disarm this check entirely.'
  )
  process.exit(1)
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

/** All active recurring prices, following Stripe's cursor pagination. */
async function listActiveRecurringPrices() {
  const out = []
  let startingAfter = null

  for (;;) {
    const qs = new URLSearchParams({ active: 'true', type: 'recurring', limit: '100' })
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
      'Fix by adding the price to PLANS in lib/stripe/client.ts with its env ' +
      'var, or — if it is deliberately not a plan, like the sponsor price — ' +
      'by naming it in KNOWN_PRICE_ENV in this script.'
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

console.log('Stripe prices and PLANS agree in both directions.')
