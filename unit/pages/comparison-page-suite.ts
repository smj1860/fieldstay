import { expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Metadata } from 'next'

import type { ComparisonRow } from '@/app/breezeway-alternative/comparison-data'
import { FIELDSTAY_HIGHLIGHTS, TRIAL_OFFER } from '@/app/breezeway-alternative/comparison-data'
import type { FaqItem } from '@/lib/faq-content'

// ============================================================================
// The shared test cases for every "<competitor> alternative" page, so a fifth
// page is one short file rather than another copy of this. It makes the same
// split unit/pages/breezeway-alternative.test.ts does: it checks the FieldStay
// side and the plumbing, and leaves the competitor side to the cited URL plus
// check date on every row (unit/guardrails/comparison-page-claims.test.ts),
// because an external fact cannot be verified from this repo.
//
// This returns CASES rather than registering them, and each test file
// registers them with its own it() call. Registering inside this helper left
// the four test files with no test call of their own, which SonarCloud reports
// as a Blocker ("Add some tests to this file or delete it") even though the
// cases ran.
// ============================================================================

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const sourcesExist = (sources: string, label: string) => {
  for (const path of sources.split(',').map((p) => p.trim())) {
    const cleaned = path.replace(/\*\*$/, '').replace(/\/$/, '')
    expect(existsSync(join(root, cleaned)), `${label} cites ${path}, which no longer exists`).toBe(true)
  }
}

export interface ComparisonCase {
  name: string
  run:  () => void | Promise<void>
}

export interface ComparisonSuiteInput {
  /** Directory slug without the suffix, e.g. 'operto-teams'. */
  slug:   string
  /** Lowercase name as it appears in the FAQ questions, e.g. 'operto teams'. */
  name:   string
  faqs:   readonly FaqItem[]
  data:   { COMPARISON_ROWS: readonly ComparisonRow[]; COMPETITOR_PRICE_CARD: { headline: string; body: string } }
  page:   { metadata: Metadata }
  jsonLd: { buildJsonLd: (url: string) => { '@graph': { '@type': string }[] } }
}

function claimsCases({ data }: ComparisonSuiteInput): ComparisonCase[] {
  return [
    {
      name: 'every row cites FieldStay source files that exist',
      run: () => {
        for (const row of data.COMPARISON_ROWS) sourcesExist(row.fieldstaySource, `"${row.category}"`)
      },
    },
    {
      name: 'every row has a competitor cell and its own source, never an empty cell',
      run: () => {
        expect(data.COMPARISON_ROWS.length).toBeGreaterThanOrEqual(5)
        for (const row of data.COMPARISON_ROWS) {
          expect(row.breezeway.length, `"${row.category}" has an empty competitor cell`).toBeGreaterThan(20)
          expect(row.breezewaySource.length, `"${row.category}" has no competitor source`).toBeGreaterThan(10)
          expect(row.breezewaySource).not.toBe(row.fieldstaySource)
        }
      },
    },
    {
      // The only permitted shapes are "X does Y" and "not independently confirmed".
      name: 'never says the competitor LACKS a feature',
      run: () => {
        for (const row of data.COMPARISON_ROWS) {
          expect(row.breezeway.toLowerCase(), `"${row.category}" asserts an absence`).not.toMatch(
            /\b(does not|doesn't|has no|have no|lacks?|without|cannot|can't|no support for)\b/,
          )
        }
      },
    },
    {
      name: 'the competitor price card is dated, and the shared highlights and trial offer cite real files',
      run: () => {
        expect(data.COMPETITOR_PRICE_CARD.headline.length).toBeGreaterThan(3)
        expect(data.COMPETITOR_PRICE_CARD.body).toMatch(/checked \d{4}-\d{2}-\d{2}/)
        for (const h of FIELDSTAY_HIGHLIGHTS) sourcesExist(h.source, h.title)
        expect(existsSync(join(root, TRIAL_OFFER.source))).toBe(true)
      },
    },
  ]
}

function structuredDataCases({ slug, name, faqs, jsonLd }: ComparisonSuiteInput): ComparisonCase[] {
  const graph = () => jsonLd.buildJsonLd('https://app.fieldstay.app')['@graph']
  return [
    {
      name: 'the FAQ schema is built from the same array the page renders',
      run: () => {
        const faqNode = graph().find((n) => n['@type'] === 'FAQPage') as unknown as { mainEntity: { name: string }[] }
        expect(faqNode.mainEntity.map((q) => q.name)).toEqual(faqs.map((f) => f.question))
        expect(read(`app/${slug}-alternative/page.tsx`)).toMatch(/faqs:\s*\w+_FAQ/)
      },
    },
    {
      name: 'every FAQ is a real question with a standalone answer, covering the long tail',
      run: () => {
        for (const f of faqs) {
          expect(f.question.endsWith('?'), `"${f.question}" should read as a question`).toBe(true)
          expect(f.answer.length, `"${f.question}" has a stub answer`).toBeGreaterThan(80)
        }
        const questions = faqs.map((f) => f.question.toLowerCase())
        for (const stem of ['difference between fieldstay and', 'cheaper than', 'switch from']) {
          expect(questions.some((q) => q.includes(`${stem} ${name}`)), `no FAQ for "${stem} ${name}"`).toBe(true)
        }
      },
    },
    {
      name: 'the entry price matches the real schedule, and the 10-property FAQ answer matches it too',
      run: async () => {
        const { monthlyCostCents } = await import('@/lib/stripe/brackets')
        const app = graph().find((n) => n['@type'] === 'SoftwareApplication') as unknown as { offers: { price: string } }
        expect(app.offers.price).toBe(String(monthlyCostCents(1)! / 100))
        const pricing = faqs.find((f) => f.id === `${slug}-alternative-pricing`)!
        expect(pricing.answer).toContain(`$${monthlyCostCents(10)! / 100}`)
      },
    },
  ]
}

function plumbingCases({ slug, name, page }: ComparisonSuiteInput): ComparisonCase[] {
  const meta = page.metadata
  return [
    {
      name: 'renders through the shared ComparisonPage and never forks the Breezeway markup',
      run: () => {
        const source = read(`app/${slug}-alternative/page.tsx`)
        expect(source).toContain("from '@/components/marketing/ComparisonPage'")
        expect(source).not.toMatch(/<table|dangerouslySetInnerHTML|NEXT_PUBLIC_|cookies\(/)
      },
    },
    {
      name: 'is in the sitemap, the route tables and the footer',
      run: () => {
        const proxy = read('proxy.ts')
        expect(read('app/sitemap.ts')).toContain(`/${slug}-alternative`)
        expect(proxy).toContain(`'/${slug}-alternative',`)
        expect(proxy).toMatch(
          new RegExp(String.raw`PRERENDERED_ROUTES = new Set\(\[[\s\S]*?'/${slug}-alternative'[\s\S]*?\]\)`),
        )
        expect(read('components/landing/site-footer.tsx')).toContain(`href: '/${slug}-alternative'`)
      },
    },
    {
      name: 'has an apex-absolute canonical and an og url that agrees with it',
      run: () => {
        const canonical = String(meta.alternates?.canonical)
        expect(canonical).toMatch(new RegExp(`^https://.+/${slug}-alternative$`))
        expect((meta.openGraph as { url: string }).url).toBe(canonical)
      },
    },
    {
      name: 'title leads with the head term and stays under 60 characters with the brand suffix',
      run: () => {
        const title = String(meta.title)
        expect(title.toLowerCase()).toContain(`${name} alternative`)
        expect(title.length + ' | FieldStay'.length).toBeLessThanOrEqual(60)
      },
    },
    {
      name: 'has its own description, quoting the computed 10-property price',
      run: async () => {
        const { monthlyCostCents } = await import('@/lib/stripe/brackets')
        expect(String(meta.description)).toContain(`$${monthlyCostCents(10)! / 100}/mo`)
      },
    },
  ]
}

function copyHygieneCases({ slug, faqs, page }: ComparisonSuiteInput): ComparisonCase[] {
  return [
    {
      name: 'has no em dash in any spelling in the data, page, metadata or FAQ',
      run: () => {
        const blob = [
          read(`app/${slug}-alternative/page.tsx`),
          read(`app/${slug}-alternative/comparison-data.ts`),
          JSON.stringify(page.metadata),
          ...faqs.map((f) => f.question + f.answer),
        ].join('\n')
        expect(blob).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/i)
      },
    },
  ]
}

export function comparisonPageCases(input: ComparisonSuiteInput): ComparisonCase[] {
  return [
    ...claimsCases(input),
    ...structuredDataCases(input),
    ...plumbingCases(input),
    ...copyHygieneCases(input),
  ]
}
