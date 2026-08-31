import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// /pricing — the dedicated pricing page. Generic SEO plumbing (canonical,
// title suffix rules, PRERENDERED_ROUTES, homepage footer link) is covered
// by unit/guardrails/marketing-pages-crawlable.test.ts. This file checks
// what's specific to this page: it uses the generic (provider-less) pricing
// component rather than the PMS-specific one, and the advertised price
// actually matches the real graduated schedule.
// ============================================================================

describe('/pricing composes the real pricing components, not a hand-rolled copy', () => {
  const page = read('app/pricing/page.tsx')

  it('uses GenericPricingSection, not the PMS-specific PricingSection', () => {
    // PricingSection.tsx is typed to provider: "ownerrez" | "hospitable" and
    // builds its CTA from that provider slug — wrong for a page with no PMS
    // context. See components/pricing/GenericPricingSection.tsx's header.
    expect(page).toContain("import GenericPricingSection from '@/components/pricing/GenericPricingSection'")
    expect(page).toContain('<GenericPricingSection')
    expect(page).not.toContain("from '@/components/pricing/PricingSection'")
  })

  it('the entry features are generic, not PMS-specific wording', () => {
    expect(page).not.toMatch(/Connect your OwnerRez/)
    expect(page).not.toMatch(/Connect your Hospitable/)
  })

  it('the advertised entry price matches the real graduated schedule\'s anchor', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    expect(page).toContain(`$${monthlyCostCents(1)! / 100}/month`)
  })

  it('links to /enterprise for large portfolios, not a dead end', () => {
    expect(page).toContain('/enterprise')
  })
})

describe('the homepage pricing teaser stays a teaser, not the full grid', () => {
  const homepage = read('components/landing/homepage-content.tsx')

  it('no longer renders the full PricingCards grid', () => {
    // Once /pricing exists, indexing the entire calculator at two URLs is
    // duplicate content for no benefit — see homepage-content.tsx's own
    // "Pricing teaser" section comment.
    expect(homepage).not.toContain('<PricingCards')
  })

  it('keeps the id="pricing" anchor for in-page links', () => {
    expect(homepage).toContain('id="pricing"')
  })

  it('links to /pricing for the full calculator', () => {
    expect(homepage).toMatch(/href="\/pricing"/)
  })

  it('the teaser price is read from the real tier, not hardcoded', () => {
    expect(homepage).toContain('${tiers[0]!.monthly}')
  })
})
