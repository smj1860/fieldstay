import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// /enterprise — the large-portfolio segment page. Generic SEO plumbing
// (canonical, title suffix rules, PRERENDERED_ROUTES, homepage footer link)
// is covered by unit/guardrails/marketing-pages-crawlable.test.ts. This file
// guards the two things specific to this page:
//
//   1. The structured data must NOT present the $49 self-serve floor as
//      "the price" for an audience that is, by definition, above the
//      self-serve ceiling — that's a real trust-eroding claim if it drifts
//      back in, not a style nit.
//   2. Every FAQ answer must stay honest about two real product limits
//      (no published SLA number, no region-scoped team permissions) rather
//      than silently start overclaiming.
// ============================================================================

describe('/enterprise does not misrepresent pricing to an above-ceiling audience', () => {
  it('the JSON-LD SoftwareApplication node has no offers block', async () => {
    const { buildJsonLd } = await import('@/app/enterprise/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication') as { offers?: unknown }

    expect(
      app.offers,
      'An /enterprise rich-result snippet naming a price implies that price applies to this audience — ' +
      'it does not. See buildFaqSoftwareJsonLd()\'s offer: null option.',
    ).toBeUndefined()
  })

  it('page.tsx passes offer: null explicitly, not by omission', () => {
    const jsonLd = readFileSync(join(root, 'app/enterprise/json-ld.ts'), 'utf8')
    expect(jsonLd).toContain('offer: null')
  })

  it('the full PricingCards grid is used, not the /hosts 2-card layout', () => {
    const page = read('app/enterprise/page.tsx')
    expect(page).toContain('GenericPricingSection')
    expect(page).not.toContain("from '@/components/pricing/PricingCards'")
  })
})

describe('/enterprise FAQ content stays honest about real product limits', () => {
  it('the SLA answer names no specific uptime percentage', async () => {
    const { FAQ_ITEMS } = await import('@/app/enterprise/json-ld')
    const sla = FAQ_ITEMS.find((f) => f.q.includes('SLA'))!
    // No published uptime number exists anywhere in this codebase (checked) —
    // a specific percentage here would be invented, not verified.
    expect(sla.a).not.toMatch(/99\.\d+%/)
  })

  it('the team-access answer says plainly that access is not yet region-scoped', async () => {
    const { FAQ_ITEMS } = await import('@/app/enterprise/json-ld')
    const teamAccess = FAQ_ITEMS.find((f) => f.q.toLowerCase().includes('different teams or regions'))!
    expect(teamAccess.a).toMatch(/not yet/i)
    expect(teamAccess.a).toMatch(/full Admin access/i)
  })

  it('the security answer does not claim a certification that isn\'t verified', async () => {
    const { FAQ_ITEMS } = await import('@/app/enterprise/json-ld')
    const security = FAQ_ITEMS.find((f) => f.q.toLowerCase().includes('security and compliance'))!
    // "consistent with SOC 2 Type II audit requirements" (a retention-practice
    // claim, matching app/privacy/page.tsx's own careful phrasing) is fine;
    // claiming the certification itself is not, since none is verified to exist.
    expect(security.a).not.toMatch(/is SOC ?2 certified|holds a SOC ?2 certification/i)
  })
})
