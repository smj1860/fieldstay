import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { BREEZEWAY_FAQ as FAQS } from '@/lib/faq-content'
import { COMPARISON_ROWS, FIELDSTAY_HIGHLIGHTS, GUARANTEE_PILLARS, TRIAL_OFFER } from '@/app/breezeway-alternative/comparison-data'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// The comparison page makes factual claims about a competitor's product. Two
// ways that goes wrong, and this file guards both — same shape as
// unit/pages/strops.test.ts, adapted for a comparison page instead of a
// capability page:
//
//   1. A FieldStay claim outlives the code that made it true. Every row and
//      highlight cites the file(s) that implement it; these tests check those
//      files still exist.
//   2. The structured data disagrees with the visible page, or a number
//      quoted in copy drifts from the real pricing schedule it claims to be
//      computed from.
//
// Deliberately NOT covered here: whether the Breezeway-side claims are still
// accurate. That's an external fact this codebase cannot verify automatically
// — comparison-data.ts's RESEARCHED_ON date and the disclaimer rendered on
// the page itself are the honesty mechanism for that, not a test.
// ============================================================================

describe('breezeway-alternative claims are backed by code that still exists', () => {
  it('every comparison row cites a FieldStay source file that exists', () => {
    for (const row of COMPARISON_ROWS) {
      const paths = row.fieldstaySource.split(',').map((p) => p.trim())
      for (const path of paths) {
        // Sources ending in a directory reference ('/' or '/**') are checked
        // as a directory; a bare file path is checked directly.
        const cleaned = path.replace(/\*\*$/, '').replace(/\/$/, '')
        expect(
          existsSync(join(root, cleaned)),
          `"${row.category}"'s FieldStay claim cites ${path}, which no longer exists`,
        ).toBe(true)
      }
    }
  })

  it('every FieldStay-only highlight cites a source file that exists', () => {
    for (const h of FIELDSTAY_HIGHLIGHTS) {
      const paths = h.source.split(',').map((p) => p.trim())
      for (const path of paths) {
        const cleaned = path.replace(/\*\*$/, '').replace(/\/$/, '')
        expect(
          existsSync(join(root, cleaned)),
          `"${h.title}" cites ${path}, which no longer exists`,
        ).toBe(true)
      }
    }
  })

  it('every Breezeway-side claim carries its own source citation, not the FieldStay one repeated', () => {
    for (const row of COMPARISON_ROWS) {
      expect(row.breezewaySource.length, `"${row.category}" has no Breezeway source`).toBeGreaterThan(10)
      expect(row.breezewaySource).not.toBe(row.fieldstaySource)
    }
  })

  it('every Record Guarantee pillar cites a source file that exists', () => {
    for (const p of GUARANTEE_PILLARS) {
      const paths = p.source.split(',').map((s) => s.trim())
      for (const path of paths) {
        // A citation naming a specific exported type ("types/database.ts
        // (WorkOrderUpdate, AuditEvent)") is checked on the file path alone —
        // the parenthesised part documents WHAT in that file, not a second
        // path to resolve.
        const filePath = path.replace(/\s*\(.*\)$/, '').replace(/\*\*$/, '').replace(/\/$/, '')
        expect(
          existsSync(join(root, filePath)),
          `"${p.title}" cites ${path}, which no longer exists`,
        ).toBe(true)
      }
    }
  })

  it('the trial offer cites a source file that exists', () => {
    expect(existsSync(join(root, TRIAL_OFFER.source)), `TRIAL_OFFER cites ${TRIAL_OFFER.source}, which no longer exists`).toBe(true)
  })

  it("the trial offer's length matches the real trial live everywhere else on the site", () => {
    // The drafted guarantee copy originally said 30 days; every other
    // marketing page (and /signup itself) says 14. Pinned here as a real
    // regression check, not a style nit — this exact mismatch was caught by
    // hand once already before this file existed to catch it automatically.
    //
    // GUARANTEE_PILLARS no longer carries the trial length at all — it was
    // split into its own TRIAL_OFFER export (RECORD_GUARANTEE_IMPLEMENTATION.md
    // Workstream 2.2), since a free trial is not a guarantee.
    const signup = read('app/(auth)/signup/page.tsx')
    expect(signup).toMatch(/14-day/)
    expect(TRIAL_OFFER.body).not.toMatch(/30[\s-]day/i)
    expect(TRIAL_OFFER.body).toMatch(/14 days/)
  })

  it('the guarantee never uses "money back" or "satisfaction guarantee" framing', () => {
    // FTC guidance on advertising guarantees treats those phrases as carrying
    // a full-refund expectation; the Record Guarantee's remedy is a credit,
    // not a refund, so neither phrase may appear anywhere near it.
    for (const p of GUARANTEE_PILLARS) {
      expect(p.body.toLowerCase()).not.toMatch(/money[\s-]back|satisfaction guarantee/)
    }
  })
})

describe('JSON-LD is emitted safely', () => {
  const page = read('app/breezeway-alternative/page.tsx')

  it('does not use dangerouslySetInnerHTML', () => {
    expect(page).not.toMatch(/dangerouslySetInnerHTML\s*=/)
  })

  it('emits the payload through serializeJsonLd, not a bare JSON.stringify', () => {
    expect(page).toContain('serializeJsonLd(buildJsonLd(marketingOrigin()))')
  })

  it('reuses strops\'s serializeJsonLd rather than a second copy of the escaping logic', () => {
    expect(read('app/breezeway-alternative/json-ld.ts')).toContain("export { serializeJsonLd } from '@/app/strops/json-ld'")
  })
})

describe('structured data cannot drift from the visible page', () => {
  it('the FAQ schema is built from the same array the page renders', async () => {
    const { buildJsonLd } = await import('@/app/breezeway-alternative/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage') as { mainEntity: { name: string }[] }

    expect(faqNode.mainEntity.map((q) => q.name)).toEqual(FAQS.map((f) => f.question))
    expect(read('app/breezeway-alternative/page.tsx')).toMatch(/<FaqDetailsSection\s+items=\{FAQS\}/)
  })

  it('every FAQ has a real question and answer, each standalone enough for an answer engine to quote', () => {
    for (const f of FAQS) {
      expect(f.question.endsWith('?'), `"${f.question}" should read as a question`).toBe(true)
      expect(f.answer.length, `"${f.question}" has a stub answer`).toBeGreaterThan(80)
    }
  })

  it('targets both head terms and the comparison-specific long tail', () => {
    const questions = FAQS.map((f) => f.question.toLowerCase())
    expect(questions.some((q) => q.includes('difference between fieldstay and breezeway'))).toBe(true)
    expect(questions.some((q) => q.includes('cheaper than breezeway'))).toBe(true)
    expect(questions.some((q) => q.includes('switch from breezeway'))).toBe(true)
  })

  it('the advertised entry price matches the real graduated schedule\'s anchor', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    const { buildJsonLd } = await import('@/app/breezeway-alternative/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication') as { offers: { price: string } }

    expect(app.offers.price).toBe(String(monthlyCostCents(1)! / 100))
  })

  it('the advertised entry price also appears on the visible page, not just in structured data', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    const page = read('app/breezeway-alternative/page.tsx')
    expect(page).toContain(`$${monthlyCostCents(1)! / 100}`)
  })

  it('the worked pricing example on the page is computed, not hand-typed, and matches the real schedule', async () => {
    const { monthlyCostCents } = await import('@/lib/stripe/brackets')
    const page = read('app/breezeway-alternative/page.tsx')

    // Pins the mechanism (computed from the import), not a literal number —
    // a literal '$148' here would pass even if the page started hardcoding
    // the wrong figure after a schedule change.
    expect(page).toContain('const EXAMPLE_QTY = 10')
    expect(page).toContain('monthlyCostCents(EXAMPLE_QTY)')

    // And the FAQ's own worked example — a hand-typed number in prose that
    // the schema/page consistency checks above can't see — is asserted
    // against the same source of truth.
    const tenPropertyFaq = FAQS.find((f) => f.id === 'breezeway-alternative-pricing')!
    expect(tenPropertyFaq.answer).toContain(`$${monthlyCostCents(10)! / 100}`)
  })
})

describe('SEO plumbing', () => {
  it('the page is in the sitemap', () => {
    expect(read('app/sitemap.ts')).toContain('/breezeway-alternative')
  })

  it('declares a canonical URL, apex-absolute', () => {
    const page = read('app/breezeway-alternative/page.tsx')
    expect(page).toMatch(/alternates:\s*\{\s*canonical:/)
    expect(page).toContain('const CANONICAL = marketingUrl(PATH)')
    expect(page).toContain('canonical: CANONICAL')
    expect(page).not.toMatch(/canonical:\s*PATH\b/)
  })

  it('sends the CTA to the APP origin absolutely — host-only auth cookies', () => {
    const page = read('app/breezeway-alternative/page.tsx')
    expect(page).toContain("appUrl('/signup?next=/onboarding')")
    // No auth-branched CTA — see app/strops/page.tsx's header comment for why
    // that forced dynamic rendering and made these pages unreliably crawlable.
    expect(page).not.toMatch(/ctaHref\s*=\s*\w+\s*\?/)
  })

  it('is reachable without a session — or a crawler indexes the login redirect', () => {
    expect(read('proxy.ts')).toContain("'/breezeway-alternative',")
  })

  it('is in PRERENDERED_ROUTES, or it is served a CSP nonce its static HTML cannot use', () => {
    expect(read('proxy.ts')).toMatch(/PRERENDERED_ROUTES = new Set\(\[[\s\S]*?'\/breezeway-alternative'[\s\S]*?\]\)/)
  })

  it('is linked from the homepage footer — a sitemap entry alone left every marketing page an orphan once already', () => {
    expect(read('components/landing/homepage-content.tsx')).toMatch(/href:\s*'\/breezeway-alternative'/)
  })

  it('title does not repeat the brand suffix the root template already appends', () => {
    const page = read('app/breezeway-alternative/page.tsx')
    const m = /title:\s*'([^']*)'/.exec(page)
    expect(m).not.toBeNull()
    expect(m![1]).not.toMatch(/—\s*FieldStay\s*$/)
  })

  it('sets its own description, not the root layout\'s fallback', () => {
    const page = read('app/breezeway-alternative/page.tsx')
    expect(page).toMatch(/description:\s*\n?\s*'/)
    expect(page).not.toContain('STR operations platform for property managers.')
  })
})
