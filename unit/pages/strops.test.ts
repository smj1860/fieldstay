import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STROPS_FAQ as FAQS } from '@/lib/faq-content'
import {
  LOADS_OFFLINE, READ_OFFLINE, WRITE_OFFLINE, RELIABILITY, NEEDS_CONNECTION,
} from '@/app/strops/offline-capabilities'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// The offline landing page makes specific technical claims to prospects in
// order to rank for "does this work without service". Two ways that goes
// wrong, and this file guards both:
//
//   1. The copy outlives the product — a capability is removed or renamed and
//      the page keeps advertising it. The claims cite their implementing file;
//      these tests check those files still contain what the claim depends on.
//   2. The structured data disagrees with the visible page. Google treats that
//      as a structured-data violation, and it happens when someone edits the
//      copy and forgets the schema blob.
// ============================================================================

describe('offline claims are backed by code that still exists', () => {
  it('the crew PWA still caches every table the page says is available offline', () => {
    const schema = read('lib/dexie/schema.ts')
    // The page promises turnovers, checklists + items, properties, inventory
    // and work orders are on the device.
    for (const table of [
      'turnovers', 'checklist_instances', 'checklist_instance_items',
      'inventory_items', 'properties', 'crew_work_orders', 'property_assets',
    ]) {
      expect(schema, `CREW_SYNCED_TABLES no longer includes ${table}, but the offline page still advertises it`)
        .toMatch(new RegExp(`${table}:\\s*'`))
    }
  })

  it('every write the page says works offline still has an upload handler', () => {
    const sync = read('lib/dexie/syncService.ts')
    // One handler key per promise made in WRITE_OFFLINE.
    for (const handler of [
      'checklist_instance_items:PUT',   // tick items
      'turnovers:PATCH',                // start/complete a turnover
      'checklist_instances:PUT',        // confirm the checklist
      'inventory_counts:PUT',           // count inventory
      'work_order_reports:PUT',         // flag maintenance
      'property_assets:PUT',            // add an asset
      'messages:PUT',                   // send a message
    ]) {
      expect(sync, `UPLOAD_HANDLERS lost '${handler}', but the offline page still advertises that action`)
        .toContain(`'${handler}'`)
    }
  })

  it('the service worker still caches the app shell — the "opens with no signal" claim', () => {
    const sw = read('public/sw.js')
    expect(sw).toContain("addEventListener('fetch'")
    expect(sw).toMatch(/request\.mode === 'navigate'/)
    expect(sw, 'the offline fallback page the SW serves for a never-visited URL')
      .toContain('/offline.html')
  })

  it('the photo upload queue the page describes still exists', () => {
    expect(read('lib/dexie/schema.ts')).toContain('pending_photo_uploads')
  })

  it('the crash-safety claim still points at a real single-transaction helper', () => {
    // "A tap cannot be half-saved" is only true because the optimistic write
    // and its outbox row commit together.
    expect(read('lib/dexie/helpers.ts')).toMatch(/writeAndQueue/)
  })

  it('the "nothing fails silently" claim still points at a real retry surface', () => {
    expect(() => read('app/crew/_components/failed-sync-banner.tsx')).not.toThrow()
  })

  it('every capability cites where it is implemented', () => {
    const all = [LOADS_OFFLINE, ...READ_OFFLINE, ...WRITE_OFFLINE, ...RELIABILITY, ...NEEDS_CONNECTION]
    for (const c of all) {
      expect(c.source, `"${c.title}" has no source citation`).toBeTruthy()
      expect(c.title.length, `"${c.title}" title is empty`).toBeGreaterThan(0)
      expect(c.body.length,  `"${c.title}" body is empty`).toBeGreaterThan(20)
    }
  })

  it('states what does NOT work offline — the honesty half of the page', () => {
    // A page that only claims wins reads like every other vendor's. If this
    // list is ever emptied, the page has stopped being trustworthy.
    expect(NEEDS_CONNECTION.length).toBeGreaterThanOrEqual(3)
    const text = NEEDS_CONNECTION.map((n) => `${n.title} ${n.body}`).join(' ').toLowerCase()
    expect(text).toContain('time off')
    expect(text).toContain('message history')
  })
})

describe('JSON-LD is emitted safely', () => {
  const page = read('app/strops/page.tsx')

  it('does not use dangerouslySetInnerHTML', () => {
    // Zero uses in this codebase, and the ESLint rule says raw HTML needs
    // DOMPurify plus a CLAUDE.md update first. A structured-data blob is not
    // what that exception is for.
    //
    // Matches the JSX ATTRIBUTE, not the bare word — the module mentions it by
    // name explaining why it is avoided, and a test that forbids discussing a
    // rule discourages documenting it.
    expect(page).not.toMatch(/dangerouslySetInnerHTML\s*=/)
  })

  it('emits the payload through serializeJsonLd, not a bare JSON.stringify', () => {
    expect(page).toContain('serializeJsonLd(buildJsonLd(marketingOrigin()))')
  })

  // The escaping itself is exercised for real — rendered through react-dom and
  // parsed back — in component/offline-jsonld.test.tsx, which also pins the
  // two React behaviours the rationale depends on. Deliberately not
  // re-asserted here as string matches: a test that re-derives the logic it
  // checks only proves the author can write the same bug twice.
})

describe('structured data cannot drift from the visible page', () => {
  it('the FAQ schema is built from the same array the page renders', async () => {
    // The schema half is asserted against the REAL object, not a text match.
    const { buildJsonLd } = await import('@/app/strops/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage') as { mainEntity: { name: string }[] }

    expect(faqNode.mainEntity.map((q) => q.name)).toEqual(FAQS.map((f) => f.question))

    // The rendered half: the page maps the same array, so a question added to
    // FAQS appears in both or neither. Google treats schema that describes
    // copy not on the page as a structured-data violation.
    expect(read('app/strops/page.tsx')).toMatch(/\{FAQS\.map/)
  })

  it('every FAQ has a real question and answer', () => {
    for (const f of FAQS) {
      expect(f.question.endsWith('?'), `"${f.question}" should read as a question`).toBe(true)
      expect(f.answer.length, `"${f.question}" has a stub answer`).toBeGreaterThan(80)
    }
  })

  it('targets the conversational long-tail query, not just head terms', () => {
    const questions = FAQS.map((f) => f.question.toLowerCase())
    expect(questions.some((q) => q.includes('low service area'))).toBe(true)
    expect(questions.some((q) => q.includes('without internet'))).toBe(true)
    expect(questions.some((q) => q.includes('rural'))).toBe(true)
  })

  it('the advertised entry price matches PLANS', async () => {
    // The SoftwareApplication offer names a price to Google. A landing page
    // quoting a stale number is the same defect class as the hardcoded
    // reviewCount: 3 in the day-7 onboarding email.
    const { PLANS } = await import('@/lib/stripe/client')
    const { buildJsonLd } = await import('@/app/strops/json-ld')
    const graph = buildJsonLd('https://app.fieldstay.app')['@graph']
    const app = graph.find((n) => n['@type'] === 'SoftwareApplication') as {
      offers: { price: string }
    }

    expect(app.offers.price).toBe(String(PLANS.hosts.monthlyPrice))
  })

  it('the advertised entry price also appears on the visible page, not just in structured data', async () => {
    // Same principle as the FAQ check above, applied to price. Until this
    // was added, the JSON-LD named $89 to Google and the rendered page never
    // said it anywhere -- exactly the "schema that describes copy not on the
    // page" violation the FAQ test's comment already warns about. Checked
    // against PLANS directly, not the string '89', so this stays correct if
    // the Hosts price ever changes and someone forgets to update the hero.
    const { PLANS } = await import('@/lib/stripe/client')
    const page = read('app/strops/page.tsx')
    expect(page).toContain(`$${PLANS.hosts.monthlyPrice}`)
  })
})

describe('SEO plumbing', () => {
  it('the page is in the sitemap', () => {
    expect(read('app/sitemap.ts')).toContain('/strops')
  })

  it('robots keeps token-bearing URLs out of the index', () => {
    const robots = read('app/robots.ts')
    // These are unauthenticated by design — the token IS the credential, so a
    // crawler following one from a forwarded email would index a live
    // capability URL.
    for (const prefix of ['/owner/', '/work-orders/', '/accept-invite/', '/crew-invite/', '/vendor-connect/', '/unsubscribe/']) {
      expect(robots, `robots.ts should disallow ${prefix}`).toContain(`'${prefix}'`)
    }
  })

  it('robots points at the sitemap', () => {
    expect(read('app/robots.ts')).toMatch(/sitemap:\s*`\$\{base\}\/sitemap\.xml`/)
  })

  it('declares a canonical URL', () => {
    expect(read('app/strops/page.tsx')).toMatch(/alternates:\s*\{\s*canonical:/)
  })

  it('canonicalises to the APEX, absolutely — not a relative path', () => {
    // fieldstay.app and app.fieldstay.app are aliases of the same deployment,
    // so this page exists at two URLs. A RELATIVE canonical would resolve
    // against the root layout's metadataBase (NEXT_PUBLIC_APP_URL) and point
    // at app.fieldstay.app — declaring the wrong one of the two as real.
    const page = read('app/strops/page.tsx')
    expect(page).toContain('const CANONICAL = marketingUrl(PATH)')
    expect(page).toContain('canonical: CANONICAL')
    expect(page).not.toMatch(/canonical:\s*PATH\b/)
  })

  it('sends the CTA to the APP origin absolutely — host-only auth cookies', () => {
    // Supabase sets no cookie `domain`, so a session created on fieldstay.app
    // is never sent to app.fieldstay.app. A relative "/signup" here would sign
    // the visitor up on the marketing host and land them logged OUT.
    const page = read('app/strops/page.tsx')
    expect(page).toContain("appUrl('/signup?next=/onboarding')")
    expect(page).toContain("appUrl('/ops')")
    expect(page).not.toMatch(/ctaHref = user \? '\/ops'/)
  })

  it('is reachable without a session — or a crawler indexes the login redirect', () => {
    // Before this entry /strops fell through to the auth gate and returned
    // 307 -> /login?next=%2Fstrops, verified against production.
    expect(read('proxy.ts')).toContain("'/strops',")
  })

  it('the sitemap and robots both use the apex, not the app host', () => {
    expect(read('app/sitemap.ts')).toContain('marketingOrigin()')
    expect(read('app/robots.ts')).toContain('marketingOrigin()')
    // Matches the env READ, not the bare name — both files name
    // NEXT_PUBLIC_APP_URL in the comment explaining why they do not use it.
    expect(read('app/sitemap.ts')).not.toContain('process.env.NEXT_PUBLIC_APP_URL')
    expect(read('app/robots.ts')).not.toContain('process.env.NEXT_PUBLIC_APP_URL')
  })
})

