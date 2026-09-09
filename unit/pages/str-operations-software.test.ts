import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCode } from '../guardrails/scan'

import { STR_OPERATIONS_FAQ } from '@/lib/faq-content'
import { BRACKETS, MAX_SELF_SERVE_PROPERTIES, monthlyCostCents } from '@/lib/stripe/brackets'
import {
  CREDIT_PER_SPONSOR_CENTS,
  MAX_SPONSORS_PER_ORG,
  MAX_SPONSOR_CREDIT_CENTS,
  SPONSOR_PRICE_CENTS,
} from '@/lib/guidebook/sponsor-economics'
import {
  BOUNDARIES, DEFINITION, PILLARS, SELF_SERVE_CEILING, TURNOVER_STEPS,
} from '@/app/short-term-rental-operations-software/capabilities'
import {
  buildJsonLd, STR_OPS_FAQ_ITEMS, STR_OPS_PATH,
} from '@/app/short-term-rental-operations-software/json-ld'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const PAGE = 'app/short-term-rental-operations-software/page.tsx'
const ORIGIN = 'https://fieldstay.app'

// ============================================================================
// /short-term-rental-operations-software is written to be QUOTED — by a rich
// result and by an answer engine that shows a few of its sentences to someone
// who will never load the page. That raises the cost of every failure mode a
// landing page already has, because a wrong number does not merely sit on our
// own site: it gets repeated by a third party we cannot edit, and it keeps
// getting repeated after we fix it.
//
// So this file guards four things:
//
//   1. Prices on the page match lib/stripe/brackets.ts, the billing source of
//      truth. The design this page was ported from quoted the RETIRED flat
//      four-tier schedule ($89/$199/$479/$799) — copy outliving the billing
//      system is not hypothetical here, it is the starting condition.
//   2. Sponsor economics match lib/guidebook/sponsor-economics.ts. This is the
//      page's headline differentiator and its most quotable claim.
//   3. The structured data and the visible copy agree. Google suppresses a
//      rich result describing content a visitor cannot see, and the usual way
//      that happens is someone editing prose and forgetting the schema blob.
//   4. Capability claims still have code behind them.
// ============================================================================

describe('pricing claims match the real graduated schedule', () => {
  it('the visible "starting at" price is the actual $49 anchor', () => {
    const anchorDollars = monthlyCostCents(1)! / 100
    expect(anchorDollars, 'BRACKETS anchor moved off $49').toBe(49)

    // The JSON-LD offers node defaults to '49' (buildFaqSoftwareJsonLd), and
    // Google requires a marked-up price to be visible on the page too.
    expect(read(PAGE), 'the hero no longer shows the $49 anchor the schema cites')
      .toContain(`Starting at $${anchorDollars}/month`)
  })

  it('the FAQ quotes every bracket rate exactly as BRACKETS defines it', () => {
    const answer = STR_OPERATIONS_FAQ.find((f) => f.q.includes('How much'))?.a
    expect(answer, 'the pricing FAQ entry was renamed or removed').toBeTruthy()

    // Walk the real schedule rather than re-typing it: a bracket edit that
    // this page does not follow fails here.
    for (const bracket of BRACKETS) {
      const cents = bracket.flatAmountCents ?? bracket.unitAmountCents!
      expect(answer, `the pricing FAQ no longer mentions the $${cents / 100} bracket rate`)
        .toContain(`$${cents / 100}`)
    }
  })

  it('never frames graduated pricing as a flat rate', () => {
    // CLAUDE.md, Marketing pricing pages: every "starting at $X" claim must
    // stay "starting at" framing, never "flat" — the graduated model has no
    // flat rate for a range, only a true minimum.
    const page = read(PAGE)
    expect(page).not.toMatch(/flat (rate|price|fee)/i)
    expect(page).toMatch(/Starting at \$/)
  })

  it('the property ceiling everywhere is MAX_SELF_SERVE_PROPERTIES', () => {
    expect(SELF_SERVE_CEILING).toBe(MAX_SELF_SERVE_PROPERTIES)

    // The uploaded design said "10–100 units". The ceiling widened to 150 on
    // 2026-08-30 and a hardcoded 100 here would understate what self-serve
    // covers to exactly the largest prospects.
    const ceilingFaq = STR_OPERATIONS_FAQ.find((f) => f.q.includes('How many properties'))?.a
    expect(ceilingFaq).toContain(String(MAX_SELF_SERVE_PROPERTIES))
    expect(read(PAGE), 'the page hardcodes a property ceiling instead of importing it')
      .not.toMatch(/1[–-]100 properties/)
  })
})

describe('sponsor economics match the code that computes the credit', () => {
  it('the FAQ quotes the real sponsor price, credit and slot ceiling', () => {
    const answer = STR_OPERATIONS_FAQ.find((f) => f.q.includes('pay for itself'))?.a
    expect(answer, 'the self-funding FAQ entry was renamed or removed').toBeTruthy()

    expect(answer).toContain(`$${SPONSOR_PRICE_CENTS / 100}/month`)
    expect(answer).toContain(`$${CREDIT_PER_SPONSOR_CENTS / 100}/month`)
    expect(answer).toContain(`${MAX_SPONSORS_PER_ORG} local`)
    expect(answer).toContain(`$${MAX_SPONSOR_CREDIT_CENTS / 100}/month back`)
  })

  it('the credit is described as starting at the FIRST sponsor, with no threshold', () => {
    // resolvePlanCredit() is flat from sponsor one — it REPLACED a two-step
    // threshold, and the replacement is the whole selling point. A page that
    // reintroduced "once you reach N" language would be describing the old
    // schedule.
    const answer = STR_OPERATIONS_FAQ.find((f) => f.q.includes('pay for itself'))!.a
    expect(answer).toMatch(/first sponsor/i)
    expect(answer).toMatch(/no threshold/i)
  })

  it('the pillar copy derives its figures rather than typing them', () => {
    const paidFor = PILLARS.find((p) => p.tag === 'Software paid for')
    expect(paidFor, 'the third pillar was renamed').toBeTruthy()
    expect(paidFor!.claim).toContain(`$${SPONSOR_PRICE_CENTS / 100}`)
    expect(paidFor!.claim).toContain(`$${CREDIT_PER_SPONSOR_CENTS / 100}`)

    // capabilities.ts must not restate a money figure as a literal — the
    // whole point of importing from sponsor-economics.ts.
    const src = read('app/short-term-rental-operations-software/capabilities.ts')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    expect(code.join('\n'), 'a dollar figure is hardcoded in capabilities.ts')
      .not.toMatch(/\$\d/)
  })
})

describe('structured data agrees with the visible page', () => {
  const graph = buildJsonLd(ORIGIN)['@graph']
  const nodeOf = (type: string) => graph.find((n) => n['@type'] === type)

  it('emits the FAQPage, SoftwareApplication, Organization, BreadcrumbList and HowTo nodes', () => {
    for (const type of [
      'FAQPage', 'SoftwareApplication', 'Organization', 'BreadcrumbList', 'HowTo',
    ]) {
      expect(nodeOf(type), `the ${type} node is missing from the @graph`).toBeTruthy()
    }
  })

  it('the SoftwareApplication description is the same sentence the page renders', () => {
    // DEFINITION is the block written to be extracted whole. If the schema and
    // the prose diverge, one of them is what gets quoted and we no longer
    // control which.
    expect((nodeOf('SoftwareApplication') as { description: string }).description).toBe(DEFINITION)
    expect(read(PAGE), 'the page no longer renders DEFINITION').toContain('{DEFINITION}')
  })

  it('the SoftwareApplication names a publisher that the graph actually defines', () => {
    const publisher = (nodeOf('SoftwareApplication') as { publisher?: { '@id': string } }).publisher
    expect(publisher, 'SoftwareApplication has no publisher — the entity has no company behind it').toBeTruthy()
    expect(publisher!['@id']).toBe((nodeOf('Organization') as { '@id': string })['@id'])
  })

  it('every FAQPage question is a question the page renders', () => {
    const marked = (nodeOf('FAQPage') as { mainEntity: Array<{ name: string }> }).mainEntity
    expect(marked.map((m) => m.name)).toEqual(STR_OPS_FAQ_ITEMS.map((f) => f.q))

    // page.tsx renders STR_OPS_FAQ_ITEMS directly, which is what makes the
    // equality above meaningful rather than circular.
    expect(read(PAGE)).toContain('STR_OPS_FAQ_ITEMS.map')
  })

  it('every HowTo step is a step the page renders, in the same order', () => {
    const steps = (nodeOf('HowTo') as { step: Array<{ name: string; position: number }> }).step
    expect(steps.map((s) => s.name)).toEqual(TURNOVER_STEPS.map((s) => s.name))
    expect(steps.map((s) => s.position)).toEqual(TURNOVER_STEPS.map((_, i) => i + 1))
    expect(read(PAGE)).toContain('TURNOVER_STEPS.map')
  })

  it('every @id is absolute and apex-hosted', () => {
    for (const node of graph as Array<{ '@id'?: string }>) {
      if (node['@id']) expect(node['@id']).toMatch(new RegExp(`^${ORIGIN}`))
    }
    expect((nodeOf('BreadcrumbList') as { '@id': string })['@id']).toBe(`${ORIGIN}${STR_OPS_PATH}#breadcrumb`)
  })
})

describe('capability claims are backed by code that still exists', () => {
  it('the 21 asset types the page advertises are still seeded', () => {
    const claim = PILLARS
      .flatMap((p) => p.items)
      .find((c) => c.title.includes('Asset health'))
    expect(claim!.body).toContain('Twenty-one asset types')

    // CLAUDE.md pins asset_type_standards at 21 types; the enum is the thing
    // that would actually have to change.
    const types = read('types/database.ts')
    expect(types, 'asset_type no longer exists — the asset-health claim needs re-checking')
      .toMatch(/AssetType|asset_type/)
  })

  it('the vendor compliance grace/hard-block windows are stated correctly', () => {
    const claim = PILLARS
      .flatMap((p) => p.items)
      .find((c) => c.title.includes('Vendor compliance'))
    // grace_period = expired 1–45 days, hard_blocked = 46+ (CLAUDE.md schema).
    expect(claim!.body).toContain('45 days')
    expect(claim!.body).toMatch(/hard-block/i)
  })

  it('the crew assignment claim names the fields that actually drive it', () => {
    const claim = PILLARS
      .flatMap((p) => p.items)
      .find((c) => c.title.includes('Automatic job assignment'))
    expect(claim!.source).toContain('home_lat')
    expect(claim!.source).toContain('suggestion_reasoning')
  })

  it('states what the product is NOT — the boundary an answer engine needs', () => {
    // Removing this section is the change most likely to look harmless and
    // cost the most: a model with no boundary guesses, and "is FieldStay a
    // booking platform" is asked far more often than "what does it do".
    expect(BOUNDARIES.length).toBeGreaterThanOrEqual(4)
    expect(BOUNDARIES.some((b) => /booking platform|channel manager/i.test(b.q))).toBe(true)
    expect(read(PAGE), 'the page no longer renders the boundaries section').toContain('BOUNDARIES.map')
  })
})

describe('the page stays statically renderable and correctly canonicalised', () => {
  const page = read(PAGE)
  // Comments STRIPPED for the auth scan. The page's own header comment
  // explains at length that it deliberately does not call cookies() or
  // auth.getUser() — and a raw-source scan reads that explanation as a live
  // call site. This is the exact trap CLAUDE.md documents under "A guardrail
  // must scan CODE, not prose", and it caught this file on its first run.
  // The assertions below that DO want the prose keep using `page`.
  const pageCode = readCode(PAGE)

  it('does no auth work at request time', () => {
    // Duplicated deliberately from the crawlability guardrail: that one checks
    // a LIST this page could be dropped from, this one checks the page itself.
    expect(pageCode).not.toMatch(/auth\.getUser\s*\(/)
    expect(pageCode).not.toMatch(/\bcookies\s*\(\s*\)/)
  })

  it('SELF-CHECK: the auth scan can actually fail', () => {
    // A scan blinded by comment-stripping and a page that is genuinely clean
    // produce identical output. Assert the pattern still matches real code.
    expect(readCode('app/(dashboard)/settings/actions.ts')).toMatch(/requireOrgMember\s*\(/)
  })

  it('canonicalises to the apex, not the app origin', () => {
    expect(page).toMatch(/const CANONICAL = marketingUrl\(PATH\)/)
    expect(page).toMatch(/alternates:\s*\{\s*canonical:\s*CANONICAL\s*\}/)
  })

  it('sends signup traffic to the app origin, where the auth cookie is valid', () => {
    // A relative /signup would create the session on the marketing host and
    // land the visitor logged OUT on the app.
    expect(page).toContain("appUrl('/signup?next=/onboarding')")
  })

  it('uses marketing CSS variables, never hardcoded Tailwind color utilities', () => {
    expect(page, 'a hardcoded Tailwind color utility crept into the page')
      .not.toMatch(/(?:text|bg|border|ring)-(?:red|blue|green|yellow|gray|slate|zinc|amber|indigo)-\d{2,3}/)
  })
})
