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
  reported = false
}
