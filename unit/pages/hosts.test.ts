import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { pricingTiers } from '@/components/pricing/plan-tiers'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ============================================================================
// /hosts — the solo-host segment landing page.
//
// Three failure modes, none of which show up as a broken build, and all three
// of which have already happened to a sibling page in this repo:
//
//   1. The page renders the WRONG TIER. It reads pricingTiers() positionally
//      (`const [hostsTier, starterTier] = ...`), so reordering plan-tiers.ts
//      silently swaps which plan is badged "Built for you" and what price the
//      hero anchors on. No type error, no crash — just a $799 card telling a
//      1-property host it was built for them.
//   2. The page is unreachable anonymously. /strops shipped this way and
//      returned 307 -> /login?next=%2Fstrops in production. A sitemap entry
//      makes it worse, not better: it hands a crawler the login redirect.
//   3. A CTA is relative. Supabase sets host-only auth cookies, so a relative
//      /signup on the marketing host starts a session app.fieldstay.app never
//      sees and the visitor lands logged OUT. /strops has this same guard.
// ============================================================================

/**
 * Blanks out comments so the page's own PROSE about what it avoids
 * ("rather than SharedPricingSection", "/ownerrez's nav links to /dashboard
 * and 404s") isn't read as the page doing it. Every negative assertion below
 * runs against `code`, not `page` — all three of them fired on the header
 * comment before this existed, which is the third time in this repo a check
 * has flagged the documentation of the very thing it guards.
 *
 * Replaced with spaces rather than removed so byte offsets stay true. Same
 * helper shape as unit/guardrails/external-fetch-timeout.test.ts.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

const page = read('app/hosts/page.tsx')
const code = stripComments(page)

describe('/hosts reads the pricing table positionally — pin the positions', () => {
  it('the first two tiers really are Hosts then Starter', () => {
    const [first, second] = pricingTiers(['x'])
    expect(
      first.name,
      'app/hosts/page.tsx destructures pricingTiers()[0] as the Hosts tier. ' +
      'Reordering plan-tiers.ts silently renders the wrong plan as the ' +
      'highlighted one — it does not fail to compile.',
    ).toBe('Hosts')
    expect(second.name).toBe('Starter')
  })

  it('the hero price anchor is read from the tier, not hardcoded', () => {
    // The badge and hero copy both interpolate hostsTier.monthly. A literal
    // "$89" here is the same defect class as /strops's JSON-LD naming a price
    // the page never showed — it drifts the moment PLANS changes.
    expect(code).toContain('${hostsTier.monthly}')
    expect(code).not.toMatch(/\$89\/mo(?!nth\})/)
  })

  it('renders exactly the two tiers, not the full five', () => {
    // Deliberate: Portfolio at $799/100 units is noise to a 2-property
    // visitor. If someone later swaps in the shared 5-card PricingSection,
    // this fails and they have to read the header comment explaining why.
    expect(code).not.toContain('SharedPricingSection')
    expect(code).toContain('{ tier: hostsTier, badge:')
    expect(code).toContain('{ tier: starterTier, badge: null }')
  })
})

describe('/hosts SEO plumbing', () => {
  it('is reachable without a session — or a crawler indexes the login redirect', () => {
    // Exactly the bug /strops shipped with. The sitemap entry below makes an
    // omission here actively harmful rather than merely invisible.
    expect(
      read('proxy.ts'),
      "proxy.ts must list '/hosts' in BYPASS_ROUTES, or anonymous traffic " +
      'gets 307 -> /login?next=%2Fhosts.',
    ).toContain("'/hosts',")
  })

  it('is in the sitemap', () => {
    expect(read('app/sitemap.ts')).toContain("'/hosts'")
  })

  it('canonicalises to the APEX, absolutely — not a relative path', () => {
    // fieldstay.app and app.fieldstay.app are aliases of one deployment, so a
    // relative canonical resolves against metadataBase (NEXT_PUBLIC_APP_URL)
    // and declares the wrong host as real.
    expect(page).toContain('const CANONICAL = marketingUrl(PATH)')
    expect(page).toContain('canonical: CANONICAL')
  })
})

describe('/hosts links cross into the app correctly', () => {
  it('sends every authenticated-flow link to the APP origin absolutely', () => {
    expect(page).toContain("appUrl('/signup?next=/onboarding')")
    expect(page).toContain("appUrl('/ops')")
    expect(page).toContain("appUrl('/login')")
  })

  it('has no relative /signup or /login left anywhere', () => {
    // The drafting bug the spec called out: three CTAs hardcoded the signup
    // URL instead of using ctaHref. Widened here to the nav and footer too,
    // which is where /ownerrez still has relative links.
    expect(code).not.toMatch(/href="\/(signup|login)/)
  })

  it('does not link to /dashboard, which does not exist', () => {
    // (dashboard) is a route GROUP — its children live at the root (/ops,
    // /turnovers, ...). /ownerrez's nav links to /dashboard and 404s.
    expect(code).not.toContain('/dashboard')
  })

  it('carries no provider query param — there is no hosts OAuth flow', () => {
    // `provider` in this codebase always means a PMS connect flow. A solo
    // host may be on no PMS at all.
    expect(code).not.toContain('provider=')
  })
})

describe('/hosts FAQ content is shared, not re-typed', () => {
  it('pulls all four answers from lib/faq-content.ts', async () => {
    const faq = await import('@/lib/faq-content')
    for (const name of [
      'HOSTS_CREW_REQUIRED_FAQ',
      'HOSTS_REPLACES_PMS_FAQ',
      'MARKETING_OFFLINE_FAQ',
      'MARKETING_TRIAL_FAQ',
    ] as const) {
      expect(faq[name], `${name} is gone from lib/faq-content.ts`).toBeTruthy()
      expect(page).toContain(name)
    }
  })

  it('the crew answer stays true to addCrewMember, which is stricter than the schema', async () => {
    // crew_members allows a name-only row (org_id + name are its only
    // NOT NULL columns without a default), but addCrewMember() rejects on
    // `!email && !phone`. An answer written to the SCHEMA would promise a
    // one-field flow the form refuses — a prospect hits that inside a minute.
    const { HOSTS_CREW_REQUIRED_FAQ } = await import('@/lib/faq-content')
    expect(HOSTS_CREW_REQUIRED_FAQ.answer).toMatch(/email or phone/i)

    const action = read('app/(dashboard)/settings/actions.ts')
    expect(
      action,
      'addCrewMember no longer requires email-or-phone — HOSTS_CREW_REQUIRED_FAQ ' +
      'was worded around that check and should be revisited.',
    ).toContain("if (!email && !phone) return { error: 'Email or phone is required' }")
  })
})
