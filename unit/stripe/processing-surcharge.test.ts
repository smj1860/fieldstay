import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import {
  processingSurchargeCents,
  platformFeePct,
  resetPlatformFeeReportingForTest,
} from '@/lib/stripe/platform-fee'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// Who pays Stripe on a vendor invoice.
//
// These are destination charges — the PaymentIntent lives on the platform
// account with transfer_data.destination set to the vendor — so Stripe's cut
// comes out of the PLATFORM balance. The platform's net was therefore
//
//     application_fee − (2.9% x total + $0.30)
//
// which at a 3% platform fee is NEGATIVE below a $300 invoice. Most vendor
// invoices are under $300. Nothing reported it, because nothing failed: the
// money just never arrived.
//
// The surcharge is passed to the payer and added to the application fee, so
// the vendor's payout is unchanged and the platform keeps its stated rate.
// Three numbers have to move together, and the whole point of this file is
// that they cannot drift apart:
//
//     charged        = amount + surcharge
//     applicationFee = platformFee + surcharge
//     vendorPayout   = charged − applicationFee   (must equal the old value)
// ============================================================================

const ORIGINAL = { ...process.env }

beforeEach(() => {
  resetPlatformFeeReportingForTest()
  vi.mocked(reportError).mockClear()
  delete process.env.STRIPE_PROCESSING_FEE_PCT
  delete process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS
  delete process.env.STRIPE_PLATFORM_FEE_PCT
})

afterEach(() => {
  process.env = { ...ORIGINAL }
})

/** What Stripe actually deducts from the platform balance on a capture. */
const stripeTakes = (chargedCents: number) => 0.029 * chargedCents + 30

describe('processingSurchargeCents', () => {
  it('defaults to the real US card rate when unconfigured', () => {
    // Unset must mean CORRECT, not zero. An unset variable that silently
    // disabled the surcharge would restore the lossmaking arrangement while
    // looking configured.
    expect(processingSurchargeCents(20_000)).toBe(Math.ceil((20_000 * 0.029 + 30) / 0.971))
  })

  it('grosses up, so the platform is not short by 2.9% of the surcharge', () => {
    const base      = 20_000                       // $200.00
    const surcharge = processingSurchargeCents(base)

    // The naive fee — percentage of the BASE — is what a reasonable person
    // writes first, and it under-recovers on every invoice forever because
    // Stripe charges on the total, surcharge included.
    const naive = Math.ceil(base * 0.029 + 30)
    expect(surcharge).toBeGreaterThan(naive)

    // The real test: after Stripe takes its cut of the grossed-up total, the
    // surcharge still covers it.
    expect(surcharge).toBeGreaterThanOrEqual(stripeTakes(base + surcharge))
  })

  it('covers Stripe across the whole realistic invoice range', () => {
    // The property this file exists to guarantee, checked over the range
    // rather than at one convenient point — an off-by-one in the rounding
    // direction only shows up at some magnitudes.
    for (const dollars of [25, 75, 150, 200, 300, 500, 1_200, 5_000]) {
      const base      = dollars * 100
      const surcharge = processingSurchargeCents(base)
      expect(
        surcharge >= stripeTakes(base + surcharge),
        `$${dollars} invoice under-recovers: surcharge ${surcharge} < Stripe ${stripeTakes(base + surcharge)}`,
      ).toBe(true)
    }
  })

  it('leaves the platform whole where it used to lose money', () => {
    // The regression, stated as money. A $200 invoice at a 3% platform fee.
    process.env.STRIPE_PLATFORM_FEE_PCT = '3'
    const base = 20_000

    const platformFee = Math.round(base * platformFeePct())   // 600 = $6.00
    const surcharge   = processingSurchargeCents(base)
    const charged     = base + surcharge
    const appFee      = platformFee + surcharge

    // BEFORE: the platform took a $6.00 application fee and paid $6.10 to
    // Stripe — ten cents down on every $200 invoice it processed.
    expect(platformFee - stripeTakes(base)).toBeLessThan(0)

    // AFTER: the fee covers Stripe and the platform keeps its 3%.
    expect(appFee - stripeTakes(charged)).toBeGreaterThanOrEqual(platformFee)

    // And the vendor is untouched — this change must not be a pay cut for
    // them. Their payout is charged minus the application fee, which is
    // algebraically the amount minus the platform fee, exactly as before.
    expect(charged - appFee).toBe(base - platformFee)
  })

  it('is off when the rate is set to zero, restoring the old arrangement', () => {
    process.env.STRIPE_PROCESSING_FEE_PCT         = '0'
    process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS = '0'
    expect(processingSurchargeCents(20_000)).toBe(0)
  })

  it('honours a negotiated rate', () => {
    process.env.STRIPE_PROCESSING_FEE_PCT         = '2.2'
    process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS = '10'
    expect(processingSurchargeCents(10_000)).toBe(Math.ceil((10_000 * 0.022 + 10) / 0.978))
  })

  it('falls back to the default and REPORTS a malformed rate', () => {
    // Same posture as platformFeePct: do not take invoice payments offline
    // over a bad env var, but never fail silently either. Falling back to 0
    // here would quietly reinstate the loss.
    process.env.STRIPE_PROCESSING_FEE_PCT = 'two point nine'

    expect(processingSurchargeCents(20_000)).toBe(Math.ceil((20_000 * 0.029 + 30) / 0.971))
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it('returns zero for a zero or nonsense amount rather than a negative fee', () => {
    expect(processingSurchargeCents(0)).toBe(0)
    expect(processingSurchargeCents(-500)).toBe(0)
    expect(processingSurchargeCents(Number.NaN)).toBe(0)
  })

  it('cannot be grossed up at 100% and does not return Infinity', () => {
    // 1/(1-pct) divides by zero at 100%. No finite charge nets the base at
    // that rate, so the ungrossed fee is the only sane answer — and an
    // Infinity here would reach Stripe as the charge amount.
    process.env.STRIPE_PROCESSING_FEE_PCT = '100'
    const out = processingSurchargeCents(10_000)
    expect(Number.isFinite(out)).toBe(true)
    expect(out).toBe(10_000 + 30)
  })
})
