import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { TURNO_FAQ as FAQS } from '@/lib/faq-content'
import { COMPARISON_ROWS, COMPETITOR_PRICE_CARD } from '@/app/turno-alternative/comparison-data'
import { FIELDSTAY_HIGHLIGHTS, TRIAL_OFFER } from '@/app/breezeway-alternative/comparison-data'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const PAGE = 'app/turno-alternative/page.tsx'

// ============================================================================
// /turno-alternative makes factual claims about a live competitor. Same two
// failure modes as unit/pages/breezeway-alternative.test.ts, and the same
// division of labour: this file checks the FieldStay side and the plumbing;
// the competitor side is guarded by the cited URL + check date on every row
// (unit/guardrails/comparison-page-claims.test.ts) and the disclaimer the page
// renders, because an external fact cannot be verified from this repo.
// ============================================================================

describe('turno-alternative claims are backed by code that still exists', () => {
  it('every row cites FieldStay source files that exist', () => {
    for (const row of COMPARISON_ROWS) {
      for (const path of row.fieldstaySource.split(',').map((p) => p.trim())) {
        const cleaned = path.replace(/\*\*$/, '').replace(/\/$/, '')
        expect(existsSync(join(root, cleaned)), `"${row.category}" cites ${path}, which no longer exists`).toBe(true)
      }
    }
  })

  it('every row has a competitor cell and its own source, never an empty cell', () => {
    expect(COMPARISON_ROWS.length).toBeGreaterThanOrEqual(5)
    for (const row of COMPARISON_ROWS) {
      expect(row.breezeway.length, `"${row.category}" has an empty competitor cell`).toBeGreaterThan(20)
      expect(row.breezewaySource.length, `"${row.category}" has no competitor source`).toBeGreaterThan(10)
      expect(row.breezewaySource).not.toBe(row.fieldstaySource)
    }
  })

  it('never says the competitor LACKS a feature', () => {
    // The only permitted shapes are "X does Y" and "not independently confirmed".
    for (const row of COMPARISON_ROWS) {
      expect(row.breezeway.toLowerCase(), `"${row.category}" asserts an absence`).not.toMatch(
        /\b(does not|doesn't|has no|have no|lacks?|without|cannot|can't|no support for)\b/,
      )
    }
  })

  it('the competitor price card is a plain headline and body', () => {
    expect(COMPETITOR_PRICE_CARD.headline.length).toBeGreaterThan(3)
    expect(COMPETITOR_PRICE_CARD.body).toMatch(/checked \d{4}-\d{2}-\d{2}/)
  })

  it('the shared FieldStay highlights and trial offer cite files that exist', () => {
    for (const h of FIELDSTAY_HIGHLIGHTS) {
      for (const path of h.source.split(',').map((p) => p.trim())) {
        expect(existsSync(join(root, path.replace(/\*\*$/, '').replace(/\/$/, ''))), `${h.title} cites ${path}`).toBe(true)
      }
    }
    expect(existsSync(join(root, TRIAL_OFFER.source))).toBe(true)
  })
})

describe('JSON-LD is emitted safely and cannot drift from the page', () => {
  const page = read(PAGE)

  it('renders through the shared ComparisonPage, not a forked copy of the Breezeway markup', () => {
    expect(page).toContain("from '@/components/marketing/ComparisonPage'")
    expect(page).not.toMatch(/<table/)
  })

  it('does not use dangerouslySetInnerHTML and serializes through serializeJsonLd', () => {
    expect(page).not.toMatch(/dangerouslySetInnerHTML\s*=/)
    expect(page).toContain('serializeJsonLd(buildJsonLd(marketingOrigin()))')
    expect(read('app/turno-alternative/json-ld.ts')).toContain("export { serializeJsonLd } from '@/app/strops/json-ld'")
  })

  it('the FAQ schema is built from the same array the page renders', async () => {
    const { buildJsonLd } = await import('@/app/turno-alternative/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage') as { mainEntity: { name: string }[] }
    expect(faqNode.mainEntity.map((q) => q.name)).toEqual(FAQS.map((f) => f.question))
    expect(page).toMatch(/faqs:\s*FAQS/)
  })

  it('every FAQ is a real question with a standalone answer', () => {
    for (const f of FAQS) {
      expect(f.question.endsWith('?'), `"${f.question}" should read as a question`).toBe(true)
      expect(f.answer.length, `"${f.question}" has a stub answer`).toBeGreaterThan(80)
    }
  })

  it('targets the head term and the comparison-specific long tail', () => {
    const questions = FAQS.map((f) => f.question.toLowerCase())
    expect(questions.some((q) => q.includes('difference between fieldstay and turno'))).toBe(true)
    expect(questions.some((q) => q.includes('cheaper than turno'))).toBe(true)
    expect(questions.some((q) => q.includes('switch from turno'))).toBe(true)
    expect(FAQS.length).toBeGreaterThanOrEqual(4)
  })

  it('the entry price in structured data matches the real schedule and is visible on the page', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    const { buildJsonLd } = await import('@/app/turno-alternative/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication') as { offers: { price: string } }
    expect(app.offers.price).toBe(String(monthlyCostCents(1)! / 100))
    expect(read('components/marketing/ComparisonPage.tsx')).toContain(`$${monthlyCostCents(1)! / 100}`)
  })

  it('the worked example is computed from the schedule, and the FAQ prose matches it', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    expect(page).toContain('const EXAMPLE_QTY = 10')
    expect(page).toContain('monthlyCostCents(EXAMPLE_QTY)')
    const pricing = FAQS.find((f) => f.id === 'turno-alternative-pricing')!
    expect(pricing.answer).toContain(`$${monthlyCostCents(10)! / 100}`)
  })
})

describe('SEO plumbing', () => {
  const page = read(PAGE)

  it('is in the sitemap, the route tables and the footer', () => {
    expect(read('app/sitemap.ts')).toContain('/turno-alternative')
    expect(read('proxy.ts')).toContain("'/turno-alternative',")
    expect(read('proxy.ts')).toMatch(/PRERENDERED_ROUTES = new Set\(\[[\s\S]*?'\/turno-alternative'[\s\S]*?\]\)/)
    expect(read('components/landing/site-footer.tsx')).toMatch(/href:\s*'\/turno-alternative'/)
  })

  it('declares an apex-absolute canonical', () => {
    expect(page).toContain('const CANONICAL = marketingUrl(PATH)')
    expect(page).toContain('canonical: CANONICAL')
  })

  it('sends the CTA to the app origin and has no auth-branched CTA', () => {
    expect(page).toContain("appUrl('/signup?next=/onboarding')")
    expect(page).not.toMatch(/ctaHref\s*=\s*\w+\s*\?/)
  })

  it('title leads with the head term and stays under 60 characters with the brand suffix', () => {
    const m = /title:\s*'([^']*)'/.exec(page)
    expect(m).not.toBeNull()
    expect(m![1].toLowerCase()).toContain('turno alternative')
    expect(m![1].length + ' | FieldStay'.length).toBeLessThanOrEqual(60)
  })

  it('sets its own description, not the root layout fallback', () => {
    expect(page).toMatch(/description:\s*\n?\s*`/)
    expect(page).not.toContain('STR operations platform for property managers.')
  })
})

describe('copy hygiene', () => {
  it('has no em dash in any spelling in the data, page or FAQ', () => {
    const blob = [read(PAGE), read('app/turno-alternative/comparison-data.ts')].join('\n') +
      FAQS.map((f) => f.question + f.answer).join('\n')
    expect(blob).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/i)
  })
})
