import { reportError } from '@/lib/observability/report-error'

/**
 * The platform's cut of a vendor invoice, as a FRACTION (0.03 for 3%).
 *
 * `STRIPE_PLATFORM_FEE_PCT` holds a percentage ("3"), and both call sites
 * previously parsed it inline with `parseFloat`. That is silently wrong for
 * every malformed value, and nothing catches it:
 *
 *   - `parseFloat('3%')` is 3 — the '%' is truncated, which happens to work.
 *   - `parseFloat('three')` is NaN. NaN survives the whole path: supabase-js
 *     JSON-serializes the RPC argument, `JSON.stringify(NaN)` is `null`, and
 *     complete_work_order_via_token()'s `COALESCE(p_platform_fee_pct, 0)`
 *     turns that null into 0. Every invoice is then written with
 *     `platform_fee_amount = 0` — no error, no log, no Sentry event. The
 *     COALESCE that stops it crashing is exactly what makes it invisible.
 *
 * This is defence in depth, not the primary control. ENV_SPEC declares the
 * variable as `percent` (z.coerce.number().min(0).max(100)) and lib/env.ts's
 * assertServerEnv() IS executed at boot from instrumentation.ts#register(),
 * where inspectVar treats present-but-malformed as an error in EVERY tier —
 * so a bad value normally refuses the boot rather than reaching this function.
 *
 * It still earns its place: `next build` is deliberately exempt from throwing
 * (the report is printed, not raised), the check is skipped entirely when the
 * variable is unset, and nothing structurally stops a future call site from
 * parsing the raw string itself. If a malformed value ever does get this far,
 * a reported 0 beats a NaN that becomes a silent 0.
 *
 * It does NOT throw. A malformed fee percentage should not take vendor
 * completions and invoice checkout offline — the resulting behaviour (a 0%
 * fee) is the same as today. What changes is that it stops being silent.
 */

/** Reported once per process rather than once per request. */
let reported = false

export function platformFeePct(): number {
  const raw = process.env.STRIPE_PLATFORM_FEE_PCT ?? '0'

  // Number(), not parseFloat(): parseFloat stops at the first non-numeric
  // character, so '3abc' and '3%' both silently become 3.
  const pct = Number(raw)

  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    if (!reported) {
      reported = true
      reportError(
        new Error(`STRIPE_PLATFORM_FEE_PCT is not a valid percentage: ${JSON.stringify(raw)}`),
        { site: 'lib.stripe.platform-fee.invalid', extra: { raw } },
      )
    }
    return 0
  }

  return pct / 100
}

/** Test seam — the report fires once per process, so tests must reset it. */
export function resetPlatformFeeReportingForTest(): void {
  reported          = false
  processingReported = false
}

// ─────────────────────────────────────────────────────────────────────────────
// Card processing surcharge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vendor invoice payments are DESTINATION CHARGES: the PaymentIntent is created
 * on the platform account with `transfer_data.destination` set to the vendor
 * and no `on_behalf_of`. That makes FieldStay the merchant of record, so
 * Stripe's processing fee comes out of the PLATFORM's balance — not the
 * vendor's, and not the paying PM's.
 *
 * Which meant the platform's net on a vendor invoice was
 *
 *     application_fee − (2.9% x total + $0.30)
 *
 * and at a 3% platform fee that is NEGATIVE below a $300 invoice and about
 * 0.1% above it. A $200 turnover repair cost FieldStay ten cents to collect.
 * Most vendor invoices are under $300, so the marketplace was structurally
 * lossmaking at its own advertised rate, with nothing anywhere reporting it —
 * the money simply never arrived.
 *
 * The fix is to charge the payer for the cost of collection, the way every
 * card surcharge works, and to raise the application fee by the same amount so
 * the surcharge lands on the platform rather than being handed to the vendor.
 * Net effect: the VENDOR's payout is unchanged, the PLATFORM keeps its stated
 * percentage intact, and the PM covers processing — which is stated on the
 * invoice and as its own Checkout line item, never buried in a total.
 */

/** Reported once per process, same reasoning as `reported` above. */
let processingReported = false

/** US card default: 2.9% + 30¢. Overridable because rates are negotiated. */
const DEFAULT_PROCESSING_PCT        = 2.9
const DEFAULT_PROCESSING_FIXED_CENTS = 30

function numericEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback

  // Number(), not parseFloat(): see platformFeePct above.
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > max) {
    if (!processingReported) {
      processingReported = true
      reportError(new Error(`${name} is not a valid number: ${JSON.stringify(raw)}`), {
        site:  'lib.stripe.platform-fee.processing-invalid',
        extra: { name, raw },
      })
    }
    return fallback
  }
  return value
}

/**
 * The surcharge to add to a `baseCents` invoice so the platform still nets its
 * full application fee after Stripe takes its cut.
 *
 * GROSSED UP, which is the part that is easy to get wrong. Stripe charges its
 * percentage on the TOTAL captured, and the total now includes the surcharge
 * itself. Charging a naive `2.9% x base + 30` leaves the platform short by
 * 2.9% of the surcharge on every single invoice — a rounding-sized leak that
 * is invisible per transaction and permanent in aggregate. Solving
 *
 *     f = pct x (base + f) + fixed
 *
 * for f gives the expression below.
 *
 * Rounded UP: a fraction of a cent shortfall is still a shortfall, and the
 * alternative is the platform absorbing a cent per invoice forever.
 *
 * Returns 0 when the rate is configured to 0 — that is the off switch, and it
 * restores exactly the previous behaviour (platform absorbs processing).
 */
export function processingSurchargeCents(baseCents: number): number {
  if (!Number.isFinite(baseCents) || baseCents <= 0) return 0

  const pct   = numericEnv('STRIPE_PROCESSING_FEE_PCT', DEFAULT_PROCESSING_PCT, 100) / 100
  const fixed = numericEnv('STRIPE_PROCESSING_FEE_FIXED_CENTS', DEFAULT_PROCESSING_FIXED_CENTS, 10_000)

  if (pct === 0 && fixed === 0) return 0

  // pct is bounded to [0,1] above, but 100% would divide by zero and any rate
  // at or above 100% cannot be grossed up at all — no finite charge nets the
  // base. Fall back to the ungrossed fee rather than returning Infinity.
  if (pct >= 1) return Math.ceil(baseCents * pct + fixed)

  return Math.ceil((baseCents * pct + fixed) / (1 - pct))
}
