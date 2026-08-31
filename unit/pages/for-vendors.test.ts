import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// /for-vendors — the vendor/contractor-facing page. Generic SEO plumbing is
// covered by unit/guardrails/marketing-pages-crawlable.test.ts. This file
// guards what's specific and easy to get wrong on the one page targeting
// the supply side rather than the PM:
//
//   1. No pricing section — vendors don't pay for FieldStay.
//   2. No premature product-name claims (OmniBid, a timeline for the
//      FieldStay<->TradeSuite integration) that this codebase cannot verify
//      is live.
//   3. The flow description matches the real live code, not the older
//      sign-off-only doc it superseded.
// ============================================================================

describe('/for-vendors sells nothing to the vendor', () => {
  const page = read('app/for-vendors/page.tsx')

  it('has no pricing section or calculator', () => {
    expect(page).not.toContain('GenericPricingSection')
    expect(page).not.toContain('PricingCards')
    expect(page).not.toMatch(/\$49/)
  })

  it('the JSON-LD SoftwareApplication node has no offers block', async () => {
    const { buildJsonLd } = await import('@/app/for-vendors/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication') as { offers?: unknown }
    expect(app.offers).toBeUndefined()
  })

  it('the primary CTA asks the vendor to refer their PM, not to sign up', () => {
    expect(page).not.toMatch(/href=\{ctaHref\}/)
    expect(page).not.toContain("appUrl('/signup")
    expect(page).toContain('mailto:?subject=')
  })
})

describe('/for-vendors makes no premature product claims', () => {
  const page = read('app/for-vendors/page.tsx')
  const jsonLd = read('app/for-vendors/json-ld.ts')

  it('never mentions OmniBid', () => {
    expect(page).not.toMatch(/OmniBid/i)
    expect(jsonLd).not.toMatch(/OmniBid/i)
  })

  it('does not claim a specific payout turnaround time', async () => {
    const { VENDOR_PAYOUT_TIMING_FAQ } = await import('@/lib/faq-content')
    // No payout SLA is published anywhere in this codebase — a specific
    // day count here would be invented, not verified.
    expect(VENDOR_PAYOUT_TIMING_FAQ.answer).not.toMatch(/\d+\s*(business\s*)?days?/i)
  })

  it('TradeSuite, when mentioned, is framed as already-live branding, not a future promise', () => {
    // "powered by TradeSuite" / "Payment processed via Stripe Connect ·
    // FieldStay · TradeSuite" are real, live strings on the dispatch email
    // and vendor portal today (emails/WorkOrderDispatch.tsx,
    // app/work-orders/[token]/vendor-portal.tsx) — referencing that existing
    // brand is fine; promising a timeline for unshipped integration work is not.
    if (/TradeSuite/.test(page)) {
      expect(page).not.toMatch(/coming soon|launching|will (soon )?integrate/i)
    }
  })
})

describe('/for-vendors flow description matches the live code, not the stale doc', () => {
  const page = read('app/for-vendors/page.tsx')

  it('describes the itemized invoice + Stripe Connect payout flow', () => {
    // docs/support/26-work-order-vendor-dispatch.md describes an older
    // sign-off-only flow with no invoice step — stale relative to
    // app/work-orders/[token]/vendor-portal.tsx's real itemized-invoice +
    // Stripe Connect payout system. This page must describe the live flow.
    expect(page).toMatch(/invoice/i)
    expect(page).toMatch(/Stripe Connect/)
  })

  it('mentions the one-time Stripe Connect payout setup step', () => {
    expect(page).toMatch(/Stripe Connect account/i)
  })
})
