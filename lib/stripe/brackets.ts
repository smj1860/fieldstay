/**
 * lib/stripe/brackets.ts
 *
 * The single source of truth for FieldStay's graduated (per-property, marginal)
 * pricing schedule — replacing the old 4-tier flat model in PLANS
 * (lib/stripe/client.ts), which jumped $110–$320 the moment a property count
 * crossed a tier boundary and was the adoption blocker this rebuild exists to
 * fix.
 *
 * The math here mirrors exactly how Stripe computes a `tiers_mode: 'graduated'`
 * price: the first unit is a flat charge (the "anchor"), and each unit above
 * that is billed at the marginal rate of the bracket IT falls in, not the
 * bracket the total quantity falls in — so crossing a boundary only changes
 * the price of the properties past the boundary, never the ones before it.
 * That is what makes this "graduated" rather than "tiered-flat": there is no
 * cliff, by construction.
 *
 * This module is READ by:
 *   - the Stripe price definition (the literal `tiers` array passed to
 *     stripe.prices.create, so the live Price and this schedule cannot drift)
 *   - scripts/check-stripe-price-drift.mjs (verifies the live Price's tiers
 *     match this schedule exactly)
 *   - the billing UI (settings-tabs.tsx BillingTab — itemized cost breakdown)
 *   - FAQ / support copy needing to quote a bracket rate
 *
 * Annual pricing is exactly 10x every monthly figure (the anchor AND every
 * per-unit rate) — the same "two months free" convention the old flat PLANS
 * used (e.g. Hosts: $89/mo, $890/yr). Never compute annual some other way; a
 * single ANNUAL_MULTIPLIER keeps that convention enforced in one place.
 */

export const ANNUAL_MULTIPLIER = 10

/**
 * One graduated bracket. `upTo` is the highest property count this bracket
 * covers (inclusive), matching Stripe's tier `up_to` semantics exactly —
 * `null` for the last bracket means "no explicit ceiling in the tiers array
 * itself," but this schedule intentionally has none: property counts above
 * MAX_SELF_SERVE_PROPERTIES are Enterprise (contact sales, no self-serve
 * Stripe price), same as the old PLANS.enterprise entry.
 *
 * `flatAmountCents` on a bracket applies ONCE, regardless of how many units
 * fall in it — used only for bracket 1 (the anchor). `unitAmountCents`
 * applies PER UNIT that falls within the bracket. A bracket has exactly one
 * of the two, never both — Stripe's own tiers array allows both on one tier,
 * but this schedule doesn't use that combination, so BRACKETS forbids it at
 * the type level to keep the math in `monthlyCostCents` simple and total.
 */
export type Bracket =
  | { upTo: number; flatAmountCents: number; unitAmountCents?: undefined }
  | { upTo: number; unitAmountCents: number; flatAmountCents?: undefined }

/**
 * The locked monthly schedule (2026-08-29 pricing rebuild):
 *   - Property 1:      $49 flat (the anchor)
 *   - Properties 2-4:  $13/property
 *   - Properties 5-15: $10/property
 *   - Properties 16-50: $8/property
 *   - Properties 51-150: $6/property
 *
 * The first four brackets (through property 50) were chosen to be
 * revenue-neutral at every OLD flat-tier ceiling (4, 15, 50 properties) and a
 * real reduction everywhere else — a deliberate margin-for-adoption tradeoff,
 * not a mechanical translation of the old prices. See the pricing-model
 * discussion this schedule came out of; do not re-derive these four from the
 * old PLANS table.
 *
 * The last bracket's ceiling was widened from 100 to 150 on 2026-08-30 —
 * capacity headroom, not a re-tuned rate: the $6/property marginal rate is
 * unchanged, so this only extends who can self-serve rather than revisiting
 * the revenue-neutral design point above (there was never an "old flat tier"
 * for 101-150 to be neutral against in the first place — Portfolio's old
 * ceiling was 100, full stop). Widening it is a pure `upTo` bump: every
 * function below is generic over the last bracket's boundary, and
 * MAX_SELF_SERVE_PROPERTIES is derived from it rather than duplicated, so
 * nothing else in this file needed to change.
 */
export const BRACKETS: readonly Bracket[] = [
  { upTo: 1,   flatAmountCents: 4_900 },
  { upTo: 4,   unitAmountCents: 1_300 },
  { upTo: 15,  unitAmountCents: 1_000 },
  { upTo: 50,  unitAmountCents: 800 },
  { upTo: 150, unitAmountCents: 600 },
] as const

/** The highest property count this schedule prices. Above this is Enterprise. */
export const MAX_SELF_SERVE_PROPERTIES = BRACKETS.at(-1)!.upTo

/**
 * Total monthly cost in cents for `quantity` properties, computed the same
 * way Stripe evaluates a graduated price: walk the brackets in order, and for
 * each one bill only the portion of `quantity` that falls inside it.
 *
 * Returns `null` for a quantity outside the self-serve range (0, or above
 * MAX_SELF_SERVE_PROPERTIES) — those are not billable through this schedule
 * at all, not a $0 or a saturated-at-100 price.
 */
export function monthlyCostCents(quantity: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SELF_SERVE_PROPERTIES) {
    return null
  }

  let total = 0
  let coveredThrough = 0

  for (const bracket of BRACKETS) {
    if (coveredThrough >= quantity) break

    const unitsInBracket = Math.min(bracket.upTo, quantity) - coveredThrough
    if (unitsInBracket <= 0) continue

    total += bracket.flatAmountCents ?? bracket.unitAmountCents * unitsInBracket

    coveredThrough = bracket.upTo
  }

  return total
}

/** Annual cost in cents — always `monthlyCostCents(quantity) * ANNUAL_MULTIPLIER`. */
export function annualCostCents(quantity: number): number | null {
  const monthly = monthlyCostCents(quantity)
  return monthly === null ? null : monthly * ANNUAL_MULTIPLIER
}

/**
 * The Stripe `tiers` array for a graduated price, in the shape
 * `stripe.prices.create({ billing_scheme: 'tiered', tiers_mode: 'graduated',
 * tiers: [...] })` expects. `interval` selects monthly (this schedule as-is)
 * or annual (every amount x ANNUAL_MULTIPLIER) — the one place both price
 * objects are derived from the same BRACKETS array, so they cannot drift
 * relative to each other.
 *
 * The LAST tier's `up_to` is the literal string `'inf'`, not `100` — Stripe
 * rejects a `tiers` array whose last element isn't the `'inf'` catch-all with
 * `"The tiers array must include a catch all tier with up_to set to 'inf' as
 * last item"`, and returns it back as `up_to: null` on every subsequent read.
 * `BRACKETS.at(-1)!.upTo` (via MAX_SELF_SERVE_PROPERTIES) is still the real
 * self-serve ceiling — nothing application-level ever sends Stripe a quantity
 * above it — this only changes what the wire format for the LAST tier's
 * boundary looks like, which is Stripe's requirement, not a schedule change.
 * This was wrong until 2026-08-30, when creating the live Price for the first
 * time surfaced it — nothing had ever round-tripped this function's output
 * through the real API before that. It's also why widening the ceiling later
 * that same day (100 -> 150) required no new Stripe Price at all: the last
 * tier was already unbounded ('inf') on the live Price, so it was already
 * correctly billing $6/property past 100 — only the application-level ceiling
 * needed to move.
 */
export function toStripeTiers(interval: 'monthly' | 'annual'): Array<{
  up_to: number | 'inf'
  flat_amount?: number
  unit_amount?: number
}> {
  const multiplier = interval === 'annual' ? ANNUAL_MULTIPLIER : 1
  return BRACKETS.map((bracket, i) => ({
    up_to: i === BRACKETS.length - 1 ? 'inf' : bracket.upTo,
    ...(bracket.flatAmountCents !== undefined
      ? { flat_amount: bracket.flatAmountCents * multiplier }
      : { unit_amount: bracket.unitAmountCents * multiplier }),
  }))
}

/** One line of a bracket-by-bracket cost breakdown — see `bracketBreakdown()`. */
export interface BracketLineItem {
  /** e.g. "Property 1" or "Properties 2–4" */
  label: string
  units: number
  /** Cents charged PER UNIT in this line (the flat anchor's own amount, for the single-unit anchor line). */
  amountCents: number
  /** `amountCents * units`. */
  lineTotalCents: number
}

/**
 * An itemized breakdown of `monthlyCostCents(quantity)` (or the annual
 * equivalent), one line per bracket the quantity actually reaches — for the
 * billing UI's "why is this my total" display. `bracketBreakdown(4)` reads
 * as "Property 1: $49" + "Properties 2–4: $13 × 3 = $39", which sums to
 * exactly `monthlyCostCents(4)`.
 *
 * Returns `[]` for the same out-of-range quantities `monthlyCostCents`
 * returns `null` for.
 */
export function bracketBreakdown(
  quantity: number,
  interval: 'monthly' | 'annual' = 'monthly',
): BracketLineItem[] {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SELF_SERVE_PROPERTIES) {
    return []
  }

  const multiplier = interval === 'annual' ? ANNUAL_MULTIPLIER : 1
  const items: BracketLineItem[] = []
  let coveredThrough = 0

  for (const bracket of BRACKETS) {
    if (coveredThrough >= quantity) break

    const unitsInBracket = Math.min(bracket.upTo, quantity) - coveredThrough
    if (unitsInBracket <= 0) continue

    const rangeStart = coveredThrough + 1
    const rangeEnd = coveredThrough + unitsInBracket

    if (bracket.flatAmountCents !== undefined) {
      items.push({
        label: 'Property 1', units: 1,
        amountCents: bracket.flatAmountCents * multiplier,
        lineTotalCents: bracket.flatAmountCents * multiplier,
      })
    } else {
      const amountCents = bracket.unitAmountCents * multiplier
      items.push({
        label: unitsInBracket === 1 ? `Property ${rangeStart}` : `Properties ${rangeStart}–${rangeEnd}`,
        units: unitsInBracket,
        amountCents,
        lineTotalCents: amountCents * unitsInBracket,
      })
    }

    coveredThrough = bracket.upTo
  }

  return items
}

/** Dollar-formatted per-unit rate for the bracket a given property count falls in — for display only ("you're paying $10/property right now"). */
export function marginalRateCentsFor(quantity: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SELF_SERVE_PROPERTIES) {
    return null
  }
  const bracket = BRACKETS.find((b) => quantity <= b.upTo)
  if (!bracket) return null
  return bracket.flatAmountCents ?? bracket.unitAmountCents ?? null
}
