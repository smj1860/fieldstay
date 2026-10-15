import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Metadata } from 'next'

import type { ComparisonRow } from '@/app/breezeway-alternative/comparison-data'
import { FIELDSTAY_HIGHLIGHTS, TRIAL_OFFER } from '@/app/breezeway-alternative/comparison-data'
import type { FaqItem } from '@/lib/faq-content'

// ============================================================================
// The shared test suite for every "<competitor> alternative" page, so a fifth
// page is one short file rather than another copy of this. It makes the same
// split unit/pages/breezeway-alternative.test.ts does: it checks the FieldStay
// side and the plumbing, and leaves the competitor side to the cited URL plus
// check date on every row (unit/guardrails/comparison-page-claims.test.ts),
// because an external fact cannot be verified from this repo.
// ============================================================================

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const sourcesExist = (sources: string, label: string) => {
  for (const path of sources.split(',').map((p) => p.trim())) {
    const cleaned = path.replace(/\*\*$/, '').replace(/\/$/, '')
    expect(existsSync(join(root, cleaned)), `${label} cites ${path}, which no longer exists`).toBe(true)
  }
}

export interface ComparisonSuiteInput {
  /** Directory slug without the suffix, e.g. 'operto-teams'. */
  slug:     string
  /** Lowercase name as it appears in the FAQ questions, e.g. 'operto teams'. */
  name:     string
  faqs:     readonly FaqItem[]
  data:     { COMPARISON_ROWS: readonly ComparisonRow[]; COMPETITOR_PRICE_CARD: { headline: string; body: string } }
  page:     { metadata: Metadata }
  jsonLd:   { buildJsonLd: (url: string) => { '@graph': { '@type': string }[] } }
}

function claimsSuite({ slug, data }: ComparisonSuiteInput) {
  describe(`${slug}-alternative claims are backed by code that still exists`, () => {
    it('every row cites FieldStay source files that exist', () => {
      for (const row of data.COMPARISON_ROWS) sourcesExist(row.fieldstaySource, `"${row.category}"`)
    })

    it('every row has a competitor cell and its own source, never an empty cell', () => {
      expect(data.COMPARISON_ROWS.length).toBeGreaterThanOrEqual(5)
      for (const row of data.COMPARISON_ROWS) {
        expect(row.breezeway.length, `"${row.category}" has an empty competitor cell`).toBeGreaterThan(20)
        expect(row.breezewaySource.length, `"${row.category}" has no competitor source`).toBeGreaterThan(10)
        expect(row.breezewaySource).not.toBe(row.fieldstaySource)
      }
    })

    it('never says the competitor LACKS a feature', () => {
      // The only permitted shapes are "X does Y" and "not independently confirmed".
      for (const row of data.COMPARISON_ROWS) {
        expect(row.breezeway.toLowerCase(), `"${row.category}" asserts an absence`).not.toMatch(
          /\b(does not|doesn't|has no|have no|lacks?|without|cannot|can't|no support for)\b/,
        )
      }
    })

    it('the competitor price card is dated, and the shared highlights and trial offer cite real files', () => {
      expect(data.COMPETITOR_PRICE_CARD.headline.length).toBeGreaterThan(3)
      expect(data.COMPETITOR_PRICE_CARD.body).toMatch(/checked \d{4}-\d{2}-\d{2}/)
      for (const h of FIELDSTAY_HIGHLIGHTS) sourcesExist(h.source, h.title)
      expect(existsSync(join(root, TRIAL_OFFER.source))).toBe(true)
    })
  })
}

function structuredDataSuite({ slug, name, faqs, jsonLd }: ComparisonSuiteInput) {
  describe(`${slug}-alternative structured data`, () => {
    const graph = jsonLd.buildJsonLd('https://app.fieldstay.app')['@graph']

    it('the FAQ schema is built from the same array the page renders', () => {
      const faqNode = graph.find((n) => n['@type'] === 'FAQPage') as unknown as { mainEntity: { name: string }[] }
      expect(faqNode.mainEntity.map((q) => q.name)).toEqual(faqs.map((f) => f.question))
      expect(read(`app/${slug}-alternative/page.tsx`)).toMatch(/faqs:\s*\w+_FAQ/)
    })

    it('every FAQ is a real question with a standalone answer, covering the long tail', () => {
      for (const f of faqs) {
        expect(f.question.endsWith('?'), `"${f.question}" should read as a question`).toBe(true)
        expect(f.answer.length, `"${f.question}" has a stub answer`).toBeGreaterThan(80)
      }
      const questions = faqs.map((f) => f.question.toLowerCase())
      for (const stem of ['difference between fieldstay and', 'cheaper than', 'switch from']) {
        expect(questions.some((q) => q.includes(`${stem} ${name}`)), `no FAQ for "${stem} ${name}"`).toBe(true)
      }
    })

    it('the entry price matches the real schedule, and the 10-property FAQ answer matches it too', async () => {
      const { monthlyCostCents } = await import('@/lib/stripe/brackets')
      const offer = (graph.find((n) => n['@type'] === 'SoftwareApplication') as unknown as { offers: { price: string } }).offers
      expect(offer.price).toBe(String(monthlyCostCents(1)! / 100))
      const pricing = faqs.find((f) => f.id === `${slug}-alternative-pricing`)!
      expect(pricing.answer).toContain(`$${monthlyCostCents(10)! / 100}`)
    })
  })
}

function plumbingSuite({ slug, name, page }: ComparisonSuiteInput) {
  describe(`${slug}-alternative SEO plumbing`, () => {
    const source = read(`app/${slug}-alternative/page.tsx`)
    const meta = page.metadata

    it('renders through the shared ComparisonPage and never forks the Breezeway markup', () => {
      expect(source).toContain("from '@/components/marketing/ComparisonPage'")
      expect(source).not.toMatch(/<table|dangerouslySetInnerHTML|NEXT_PUBLIC_|cookies\(/)
    })

    it('is in the sitemap, the route tables and the footer', () => {
      expect(read('app/sitemap.ts')).toContain(`/${slug}-alternative`)
      expect(read('proxy.ts')).toContain(`'/${slug}-alternative',`)
      expect(read('proxy.ts')).toMatch(new RegExp(`PRERENDERED_ROUTES = new Set\\(\\[[\\s\\S]*?'/${slug}-alternative'[\\s\\S]*?\\]\\)`))
      expect(read('components/landing/site-footer.tsx')).toContain(`href: '/${slug}-alternative'`)
    })

    it('has an apex-absolute canonical and an og url that agrees with it', () => {
      const canonical = String(meta.alternates?.canonical)
      expect(canonical).toMatch(new RegExp(`^https://.+/${slug}-alternative$`))
      expect((meta.openGraph as { url: string }).url).toBe(canonical)
    })

    it('title leads with the head term and stays under 60 characters with the brand suffix', () => {
      const title = String(meta.title)
      expect(title.toLowerCase()).toContain(`${name} alternative`)
      expect(title.length + ' | FieldStay'.length).toBeLessThanOrEqual(60)
    })

    it('has its own description, quoting the computed 10-property price', async () => {
      const { monthlyCostCents } = await import('@/lib/stripe/brackets')
      expect(String(meta.description)).toContain(`$${monthlyCostCents(10)! / 100}/mo`)
    })
  })
}

function copyHygieneSuite({ slug, faqs, page }: ComparisonSuiteInput) {
  describe(`${slug}-alternative copy hygiene`, () => {
    it('has no em dash in any spelling in the data, page, metadata or FAQ', () => {
      const blob = [
        read(`app/${slug}-alternative/page.tsx`),
        read(`app/${slug}-alternative/comparison-data.ts`),
        JSON.stringify(page.metadata),
        ...faqs.map((f) => f.question + f.answer),
      ].join('\n')
      expect(blob).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/i)
    })
  })
}

export function describeComparisonPage(input: ComparisonSuiteInput) {
  claimsSuite(input)
  structuredDataSuite(input)
  plumbingSuite(input)
  copyHygieneSuite(input)
}
