/**
 * scripts/migrate-platform-price.ts
 *
 * One-off migration for the 2026-09-24 anchor re-price ($49 -> $19 on
 * property 1 — see lib/stripe/brackets.ts and CLAUDE.md's Billing section).
 *
 * Stripe Prices are immutable, so cutting the anchor meant creating two new
 * graduated Prices (monthly + annual) rather than editing the live ones —
 * every subscription still sitting on the OLD price id needs its item moved
 * to the NEW one, or it silently stops being recognized as the platform
 * price at all: isPlatformPriceId() (lib/stripe/client.ts) only matches the
 * price ids currently named by STRIPE_PRICE_PLATFORM_MONTHLY/_ANNUAL, so an
 * unmigrated subscription would drop out of both the webhook's plan/
 * max_properties sync (core-billing.ts) and the daily property-count
 * reconciliation cron (billing-property-reconciliation.ts) the moment those
 * env vars are repointed at the new ids.
 *
 * Quantity and billing interval are carried over exactly — this script only
 * ever changes WHICH Price an existing subscription item points at, the
 * same `stripe.subscriptions.update(id, { items: [{ id, price, quantity }] })`
 * shape billing-property-reconciliation.ts already uses for quantity-only
 * updates, with `proration_behavior: 'none'` so nothing is charged or
 * credited as a side effect of the swap itself.
 *
 * WRITTEN FOR TEST-ACCOUNT MIGRATION ONLY. It does not handle proration
 * messaging, does not email anyone, and assumes every subscriber can be
 * moved without a "why did my invoice change" conversation. Do not point
 * this at a Stripe account with real paying customers without redesigning
 * for that — see the grandfather-vs-migrate discussion this script came out
 * of.
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-platform-price.ts \
 *     --old-monthly price_OLD_MONTHLY --old-annual price_OLD_ANNUAL \
 *     --new-monthly price_NEW_MONTHLY --new-annual price_NEW_ANNUAL
 *
 * Defaults to a PLAN (dry run) that writes nothing — lists every active
 * subscription on either old price and exactly what it would move to and
 * why. Pass --apply to actually run the migration.
 */

import Stripe from 'stripe'

function readArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`)
  return idx === -1 ? null : (process.argv[idx + 1] ?? null)
}

const APPLY = process.argv.includes('--apply')

const oldMonthly = readArg('old-monthly')
const oldAnnual  = readArg('old-annual')
const newMonthly = readArg('new-monthly')
const newAnnual  = readArg('new-annual')

if (!oldMonthly || !oldAnnual || !newMonthly || !newAnnual) {
  console.error(
    'Usage: tsx scripts/migrate-platform-price.ts ' +
    '--old-monthly price_xxx --old-annual price_xxx ' +
    '--new-monthly price_xxx --new-annual price_xxx [--apply]',
  )
  process.exit(1)
}

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.')
  process.exit(1)
}

const stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia', typescript: true })

/** Old price id -> new price id, keyed so a subscription's own interval decides which new price it gets. */
const PRICE_MAP = new Map<string, string>([
  [oldMonthly, newMonthly],
  [oldAnnual, newAnnual],
])

interface PlannedMove {
  subscriptionId: string
  itemId:         string
  quantity:       number
  fromPrice:      string
  toPrice:        string
}

async function findSubscriptionsOnOldPrice(): Promise<PlannedMove[]> {
  const moves: PlannedMove[] = []

  // Stripe has no "subscriptions for this price" filter, so this walks every
  // active subscription once — acceptable for a one-off migration against a
  // handful of test accounts, not something to run as a recurring job.
  for await (const subscription of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
    for (const item of subscription.items.data) {
      const toPrice = PRICE_MAP.get(item.price.id)
      if (!toPrice) continue

      moves.push({
        subscriptionId: subscription.id,
        itemId:         item.id,
        quantity:       item.quantity ?? 1,
        fromPrice:      item.price.id,
        toPrice,
      })
    }
  }

  return moves
}

async function main() {
  const moves = await findSubscriptionsOnOldPrice()

  if (moves.length === 0) {
    console.log('No active subscriptions found on either old price. Nothing to migrate.')
    return
  }

  console.log(`Found ${moves.length} subscription item(s) to migrate:`)
  for (const move of moves) {
    console.log(
      `  • ${move.subscriptionId} (item ${move.itemId}, qty ${move.quantity}): ` +
      `${move.fromPrice} -> ${move.toPrice}`,
    )
  }

  if (!APPLY) {
    console.log('\nDry run only — pass --apply to actually migrate these subscriptions.')
    return
  }

  console.log('\nApplying...')
  let migrated = 0
  for (const move of moves) {
    try {
      await stripe.subscriptions.update(
        move.subscriptionId,
        {
          items:              [{ id: move.itemId, price: move.toPrice, quantity: move.quantity }],
          proration_behavior: 'none',
        },
        { idempotencyKey: `migrate-platform-price:${move.subscriptionId}:${move.toPrice}` },
      )
      migrated++
      console.log(`  ✓ ${move.subscriptionId} -> ${move.toPrice}`)
    } catch (err) {
      console.error(`  ✗ ${move.subscriptionId} failed:`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`\nMigrated ${migrated}/${moves.length} subscription(s).`)
}

main()
