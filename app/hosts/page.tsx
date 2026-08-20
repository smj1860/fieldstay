// app/hosts/page.tsx
//
// The one segment on the pricing ladder with zero top-of-funnel page. The
// Hosts tier ($89/mo, 1-4 properties — see lib/stripe/client.ts PLANS.hosts)
// is real and billable, but today only surfaces on /ownerrez and /hospitable,
// which a solo host only reaches via a branded PMS-specific search. This page
// gives that persona a landing page whose ICP framing actually matches the
// price they'd pay, instead of the homepage hero's eyebrow, which frames the
// product around portfolios before they ever reach the pricing table.
//
// Structurally a sibling of /ownerrez and /hospitable (dark hero -> pricing
// -> proof -> features -> FAQ -> gold CTA), not of /strops -- this is a
// segment/conversion page, not an SEO editorial page.
//
// ── On colors: brand-* utilities, --mkt-* tokens, no raw hex ────────────────
//
// /ownerrez and /hospitable hardcode gold-300/gray-500/#0a1628 throughout, and
// both are grandfathered onto unit/guardrails/tailwind-color-ratchet.test.ts's
// BASELINE. That baseline is shrink-only and its header says outright that a
// marketing surface has real tokens now, so a NEW landing page has no excuse
// to arrive with either. So this page keeps the brand-* scale (real named
// tokens in tailwind.config.ts, and what makes it look like a sibling of those
// two) and uses the --mkt-* palette everywhere those two would have reached
// for a Tailwind color utility or a literal hex. That is not a visual
// compromise: --mkt-gold IS #FCD116 (gold-300), --mkt-ink IS #0a1628,
// --mkt-muted IS gray-500, --mkt-surface IS #f8fafc. Same pixels, no baseline
// entry. See the "Marketing palette" block in app/globals.css.
//
// Pricing renders only 2 cards (Hosts + Starter), not the full 5-tier grid --
// deliberate, not a missing feature. A 2-property visitor doesn't need
// Portfolio ($799, 100 units) in their face. Reuses pricingTiers() for the
// underlying numbers (single source of truth, same file /ownerrez and
// /hospitable pull from) but writes its own compact card markup rather than
// SharedPricingSection, which is built for a 5-card grid with Growth
// highlighted -- forcing that here would either highlight the wrong tier for
// this audience or require prop surgery on a component two revenue pages
// already depend on. Cheaper and safer to keep the presentation local and
// only share the data.
//
// No PMS-specific connect flow exists for this page (a solo host may not be
// on any PMS at all), so ctaHref mirrors /strops's simpler two-state pattern
// -- straight to signup, not to a provider OAuth route.
//
// EVERY link that crosses into the product goes through appUrl(), including
// the nav, the footer and the "Already have an account?" line -- not just the
// CTAs. Supabase sets host-only auth cookies (no `domain`), so a relative
// /login or /signup on the marketing host starts a session app.fieldstay.app
// never sees. /ownerrez has relative links here and is left alone; this page
// does not inherit that.

import Link from 'next/link'
import type { Metadata } from 'next'
import RepuGuardWrapper from '@/components/repuguard/RepuGuardWrapper'
import FaqSection from '@/components/faq/FaqSection'
import { pricingTiers } from '@/components/pricing/plan-tiers'
import {
  MARKETING_TRIAL_FAQ,
  MARKETING_OFFLINE_FAQ,
  HOSTS_CREW_REQUIRED_FAQ,
  HOSTS_REPLACES_PMS_FAQ,
} from '@/lib/faq-content'
import { marketingUrl, appUrl } from '@/lib/marketing'

const PATH = '/hosts'
const CANONICAL = marketingUrl(PATH)

// The Hosts tier's own feature bullets -- what pricingTiers() renders on its
// entry card. No PMS named first (unlike /ownerrez and /hospitable's entry
// bullets) since this page doesn't sell against one specific integration.
const HOSTS_FEATURES = [
  'Airbnb/VRBO iCal sync — or connect OwnerRez/Hospitable',
  'Offline turnover checklist + photo capture',
  'Self-funding guest guidebook',
  'No-login vendor portal',
  'Asset health + CapEx forecasting',
  'RepuGuard reputation management',
] as const

// Destructured BY POSITION. pricingTiers() returns [Hosts, Starter, Growth,
// Portfolio, Enterprise]; reordering that array silently renders the wrong
// plan as the highlighted one here — no compile error, no crash, just a card
// telling a 1-property host that Portfolio was built for them.
// unit/pages/hosts.test.ts pins the two positions for exactly that reason.
const [hostsTier, starterTier] = pricingTiers(HOSTS_FEATURES)

// Module scope, so the SEO title and social descriptions below quote the same
// number the page renders. A price hardcoded in metadata is the same defect
// as /strops's JSON-LD naming $89 while the page showed nothing — it just
// drifts somewhere a human never looks instead of somewhere they do.
const HOSTS_PRICE = `$${hostsTier.monthly}`

export const metadata: Metadata = {
  // Absolute apex canonical -- same reasoning as every other public page:
  // fieldstay.app and app.fieldstay.app are aliases of one deployment, so a
  // relative value would resolve against metadataBase (NEXT_PUBLIC_APP_URL)
  // to the wrong host.
  alternates: { canonical: CANONICAL },
  title: `FieldStay for Solo Hosts — 1–4 Properties, ${HOSTS_PRICE}/mo`,
  description:
    'FieldStay’s Hosts plan gives 1–4 property owners offline turnover checklists, a no-login vendor ' +
    `portal, and CapEx forecasting for ${HOSTS_PRICE}/month. 14-day free trial, no credit card, no crew required.`,
  keywords: [
    'software for airbnb hosts',
    'vacation rental software one property',
    'property management app small portfolio',
    'STR software for solo hosts',
    'airbnb host operations app',
    'short term rental app no team',
  ],
  openGraph: {
    title: 'FieldStay for Solo Hosts',
    description: 'You’re the owner, the manager, and the cleaner. One app for all three.',
    url: CANONICAL,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FieldStay for Solo Hosts',
    description: `Offline turnover checklists, a no-login vendor portal, and CapEx forecasting for ${HOSTS_PRICE}/mo.`,
    images: ['/logo.png'],
  },
}

const FAQ_ITEMS = [
  { q: HOSTS_CREW_REQUIRED_FAQ.question, a: HOSTS_CREW_REQUIRED_FAQ.answer },
  { q: HOSTS_REPLACES_PMS_FAQ.question, a: HOSTS_REPLACES_PMS_FAQ.answer },
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
] as const

function CheckDot() {
  return (
    <div className="w-5 h-5 bg-[var(--mkt-gold)] rounded-full flex items-center justify-center flex-shrink-0">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
        <path
          d="M1 4l3 3 5-6"
          stroke="var(--mkt-ink)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

// ── NO AUTH CHECK HERE, ON PURPOSE ──────────────────────────────────────────
//
// This page used to call cookies() + supabase.auth.getUser() to swap the CTA
// between "Sign up" and "Go to dashboard". That cost far more than it was
// worth: cookies() forces DYNAMIC rendering (no static generation, no CDN
// cache, a cold server render on every request including every crawl), and
// getUser() is a network round trip to Supabase Auth with no timeout, on a
// page whose whole purpose is to be fetched by strangers. For a crawler the
// answer is ALWAYS "no user".
//
// Measured against production 2026-08-19: these pages intermittently failed to
// respond at all — connection hang to timeout, /hosts on 3 of 8 requests —
// while example.com / google.com / vercel.com were 12 of 12 clean. Google
// reported all seven marketing and legal URLs as "Discovered - currently not
// indexed", "Last crawled: N/A": the signature of Google throttling a host it
// cannot reliably fetch.
//
// The branch was also REDUNDANT. proxy.ts already redirects an authenticated
// visitor away from /login and /signup to /ops
// (redirectAuthenticatedAwayFromPublic), so a logged-in reader clicking the
// logged-out CTA still lands in the app. All that is lost is a nav label
// reading "Log In" rather than "Dashboard" for a logged-in visitor on an
// acquisition page — not who these pages are for.
//
// proxy.ts already made this argument at the middleware layer, under the
// heading "ANONYMOUS TRAFFIC PAYS NOTHING". The pages did the work anyway.
export default function HostsPage() {
  const isLoggedIn = false

  // Absolute against the APP origin -- see /strops's identical comment.
  // Supabase's cookie writer sets no `domain`, so a relative /signup here
  // would create a session the app subdomain never sees.
  const ctaHref   = isLoggedIn ? appUrl('/ops') : appUrl('/signup?next=/onboarding')
  const loginHref = appUrl('/login')

  return (
    <div className="min-h-screen">

      {/* ══════════════════════════════════════════
          SECTION 1 — DARK NAVY: Nav · Price badge · Hero
      ══════════════════════════════════════════ */}
      <div className="bg-brand-800 text-white">
        <div className="max-w-6xl mx-auto px-6">

          <nav className="flex items-center justify-between py-5">
            <span className="text-xl font-black">
              <span className="text-white">Field</span>
              <span className="text-[var(--mkt-gold)]">Stay</span>
            </span>
            {/* Logged-in target is /ops, not /dashboard. There is no
                app/dashboard route -- (dashboard) is a route GROUP, so its
                children live at the root (/ops, /turnovers, ...). /ownerrez's
                nav links to /dashboard and 404s; not repeating that here. */}
            <Link
              href={isLoggedIn ? appUrl('/ops') : loginHref}
              className="text-sm text-white/58 hover:text-white transition-colors"
            >
              {isLoggedIn ? 'Dashboard' : 'Log In'}
            </Link>
          </nav>

          {/* Price badge, in the slot /ownerrez and /hospitable use for their
              partner lockup -- there's no partner here, and an $89/mo price
              anchor above the fold does more for a price-sensitive visitor
              than a generic eyebrow would. Reads the tier rather than
              hardcoding "89", so it cannot drift from PLANS. */}
          <div className="flex justify-center mt-6 mb-10">
            <div className="flex items-center gap-2 bg-brand-panel border border-brand-panelBorder rounded-full px-4 py-2">
              <span className="text-[var(--mkt-ink)] text-xs font-bold px-2 py-0.5 rounded bg-[var(--mkt-gold)]">
                ${hostsTier.monthly}/mo
              </span>
              <span className="text-xs font-semibold tracking-widest text-white/58 uppercase">
                For Hosts Running {hostsTier.properties}
              </span>
            </div>
          </div>

          <div className="max-w-2xl mx-auto text-center pb-20">
            <h1 className="text-4xl lg:text-5xl font-bold leading-tight mb-6 font-display">
              You&apos;re the owner, the manager, and the cleaner.{' '}
              <span className="text-[var(--mkt-gold)]">One app for all three.</span>
            </h1>
            <p className="text-white/52 text-lg leading-relaxed mb-8 mx-auto" style={{ maxWidth: 560 }}>
              FieldStay&apos;s Hosts plan gives 1–4 property owners the same offline turnover
              checklists, no-login vendor invoicing, and owner-grade CapEx forecasting used by
              professional management companies — for ${hostsTier.monthly}/month. The guest
              guidebook can pay some of that back.
            </p>

            <Link
              href={ctaHref}
              className="inline-flex items-center gap-2 rounded-lg font-black text-base transition-opacity bg-[var(--mkt-gold)] text-brand-800"
              style={{ padding: '16px 36px' }}
            >
              Start Your Free 14-Day Trial <span style={{ fontSize: 20 }}>→</span>
            </Link>
            <p className="mt-4 text-sm text-white/38">
              No credit card. No crew to invite. Add your first property in under 15 minutes.
            </p>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 2 — WHITE: Two ways to get your bookings in
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold mb-8 text-center text-[var(--mkt-ink)] font-display">
            Two ways to get your bookings in
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[var(--mkt-surface)] border border-[var(--mkt-border)] rounded-2xl p-6">
              <p className="font-bold text-lg mb-2 text-[var(--mkt-ink)]">Not on a PMS</p>
              <p className="text-sm leading-relaxed text-[var(--mkt-muted)]">
                Paste your Airbnb or VRBO iCal link. Bookings sync automatically — no
                account to connect, nothing to authorize.
              </p>
            </div>
            <div className="bg-[var(--mkt-surface)] border border-[var(--mkt-border)] rounded-2xl p-6">
              <p className="font-bold text-lg mb-2 text-[var(--mkt-ink)]">Already on OwnerRez or Hospitable</p>
              <p className="text-sm leading-relaxed text-[var(--mkt-muted)] mb-3">
                Connect in about 2 minutes. Properties and bookings sync in immediately.
              </p>
              <div className="flex gap-4 text-sm font-semibold">
                <Link href="/ownerrez" className="text-[var(--mkt-ink)] underline hover:no-underline">OwnerRez →</Link>
                <Link href="/hospitable" className="text-[var(--mkt-ink)] underline hover:no-underline">Hospitable →</Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 3 — LIGHT GRAY: Pricing (2 cards only)
      ══════════════════════════════════════════ */}
      <div style={{ background: 'var(--mkt-surface)' }}>
        <div className="max-w-4xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-2 text-[var(--mkt-ink)] font-display">
              Priced like you&apos;re actually solo.
            </h2>
            <p className="text-[var(--mkt-muted-strong)] text-sm max-w-md mx-auto">
              Most STR software prices per property or per user — brutal at this scale.
              FieldStay&apos;s Hosts plan is flat.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            {[
              { tier: hostsTier, badge: 'Built for you' },
              { tier: starterTier, badge: null },
            ].map(({ tier, badge }) => (
              <div
                key={tier.name}
                className={
                  badge
                    ? 'rounded-2xl p-7 bg-brand-800 border-2 border-[var(--mkt-gold)] relative'
                    : 'rounded-2xl p-7 bg-white border border-[var(--mkt-border)] relative'
                }
              >
                {badge && (
                  <span className="absolute -top-3 left-6 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider bg-[var(--mkt-gold)] text-brand-800">
                    {badge}
                  </span>
                )}
                <p className={`font-black text-lg mb-1 ${badge ? 'text-white' : 'text-[var(--mkt-ink)]'}`}>
                  {tier.name}
                </p>
                <p className={`text-sm mb-1 ${badge ? 'text-white/60' : 'text-[var(--mkt-muted)]'}`}>
                  {tier.description}
                </p>
                <p className={`text-xs mb-5 ${badge ? 'text-white/40' : 'text-[var(--mkt-muted)]'}`}>
                  {tier.properties}
                </p>
                <div className="mb-5">
                  <span className={`font-black tracking-tight ${badge ? 'text-[var(--mkt-gold)]' : 'text-brand-800'}`}
                        style={{ fontSize: 40, letterSpacing: '-1.5px' }}>
                    ${tier.monthly}
                  </span>
                  <span className={`text-sm ml-1 ${badge ? 'text-white/50' : 'text-[var(--mkt-muted)]'}`}>/mo</span>
                  <p className={`text-xs mt-1 ${badge ? 'text-white/40' : 'text-[var(--mkt-muted)]'}`}>
                    or ${tier.annual!.toLocaleString()}/yr — save ${tier.annualSavings}
                  </p>
                </div>
                <ul className="space-y-2 mb-6">
                  {tier.features.map((f) => (
                    <li key={f} className={`flex items-start gap-2 text-sm ${badge ? 'text-white/70' : 'text-[var(--mkt-muted-strong)]'}`}>
                      <CheckDot />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={ctaHref}
                  className={
                    badge
                      ? 'block text-center rounded-lg font-bold text-sm py-3 bg-[var(--mkt-gold)] text-brand-800'
                      : 'block text-center rounded-lg font-bold text-sm py-3 bg-brand-800 text-white'
                  }
                >
                  Start Free Trial
                </Link>
              </div>
            ))}
          </div>

          <p className="text-center text-xs text-[var(--mkt-muted)]">
            Managing more than 15 properties?{' '}
            <Link href="/" className="underline text-brand-800 font-semibold">See full plans →</Link>
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 4 — WHITE: Features, guidebook leads
      ══════════════════════════════════════════ */}
      <div className="bg-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-3xl font-bold mb-2 text-center text-[var(--mkt-ink)] font-display">
            Built for hosts who are also the owner.
          </h2>
          <p className="text-[var(--mkt-muted)] text-center mb-12">
            Not a stripped-down version of the professional tier — the same engine, sized for you.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              {
                num: '01',
                title: 'Self-Funding Guest Guidebook',
                body: 'Local businesses sponsor a placement in your guest guidebook for $15/month each. At 5 active sponsors, that’s a $10/month credit on your plan. At 6, it’s $25 — more than a quarter of your Hosts plan, covered.',
                highlight: true,
              },
              {
                num: '02',
                title: 'No-Login Vendor Portal',
                body: 'You still call a plumber sometimes. They still shouldn’t need a password. Send a link, get an itemized invoice back from their phone, approve it once, payment lands in their account.',
              },
              {
                num: '03',
                title: 'Asset Health + CapEx Forecasting',
                body: 'You’re the owner too. Every appliance gets a health score that updates daily, rolled into a 10-year capital forecast — know what the next water heater costs before it fails, not after.',
              },
              {
                num: '04',
                title: 'Offline Turnover Checklist',
                body: (
                  <>
                    Works with zero signal —{' '}
                    <Link href="/strops" className="underline font-semibold text-[var(--mkt-ink)]">
                      built specifically for that
                    </Link>.
                  </>
                ),
              },
            ].map((f) => (
              <div
                key={f.num}
                className={
                  f.highlight
                    ? 'bg-brand-panel border border-brand-panelBorder rounded-2xl p-6'
                    : 'bg-[var(--mkt-surface)] border border-[var(--mkt-border)] rounded-2xl p-6'
                }
              >
                <div className={`text-xs font-bold mb-3 inline-block px-2 py-0.5 rounded ${
                  f.highlight ? 'bg-[var(--mkt-gold)] text-[var(--mkt-ink)]' : 'bg-brand-800 text-[var(--mkt-gold)]'
                }`}>
                  {f.num}
                </div>
                <h3 className={`font-bold text-lg mb-3 ${f.highlight ? 'text-white' : 'text-[var(--mkt-ink)]'}`}>
                  {f.title}
                </h3>
                <p className={`text-sm leading-relaxed ${f.highlight ? 'text-white/52' : 'text-[var(--mkt-muted)]'}`}>
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 5 — DARK NAVY: RepuGuard live demo
      ══════════════════════════════════════════ */}
      <div className="bg-brand-800 text-white">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 mb-4">
              <div className="bg-[var(--mkt-gold)] text-[var(--mkt-ink)] text-xs font-bold px-2.5 py-1 rounded-md tracking-wider">
                REPUGUARD
              </div>
              <span className="text-white/46 text-sm">Included with the Hosts plan</span>
            </div>
            <h2 className="text-3xl font-bold mb-3 font-display">
              Watch it draft a response, live.
            </h2>
            <p className="text-white/46 text-lg max-w-xl mx-auto">
              A bad review costs a 3-property host a lot more, proportionally, than a
              50-property one. Choose a scenario below and see RepuGuard draft a response
              before your coffee&apos;s done.
            </p>
          </div>
          <RepuGuardWrapper />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          SECTION 6 — FAQ
      ══════════════════════════════════════════ */}
      <FaqSection items={FAQ_ITEMS} />

      {/* ══════════════════════════════════════════
          SECTION 7 — YELLOW: Bottom CTA
      ══════════════════════════════════════════ */}
      <div className="bg-[var(--mkt-gold)]">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-3 text-[var(--mkt-ink)] font-display">
            Add your first property in the next 15 minutes.
          </h2>
          <p className="text-[var(--mkt-ink)]/70 text-lg mb-3">
            No crew to invite, no spreadsheet to migrate, no credit card.
          </p>
          <p className="text-[var(--mkt-ink)]/70 text-sm font-semibold mb-10">
            Cancel with one click if it doesn&apos;t save you real time in the first week.
          </p>

          <div className="max-w-sm mx-auto">
            <Link
              href={ctaHref}
              className="block w-full bg-brand-800 text-white font-bold px-8 py-4 rounded-xl hover:bg-[var(--mkt-ink-hover)] transition-colors text-lg text-center mb-4"
            >
              Start Your Free 14-Day Trial
            </Link>
            {!isLoggedIn && (
              <p className="text-sm text-[var(--mkt-ink)]/60">
                Already have an account?{' '}
                <Link href={loginHref} className="text-[var(--mkt-ink)] font-semibold underline hover:no-underline transition-all">
                  Log in
                </Link>
              </p>
            )}
          </div>

          <p className="mt-10 text-sm text-[var(--mkt-ink)]/50">
            Already using OwnerRez or Hospitable?{' '}
            <Link href="/ownerrez" className="underline hover:text-[var(--mkt-ink)]">OwnerRez</Link>
            {' · '}
            <Link href="/hospitable" className="underline hover:text-[var(--mkt-ink)]">Hospitable</Link>
          </p>
          <p className="mt-4 text-sm text-[var(--mkt-ink)]/50">
            Questions?{' '}
            <a href="mailto:hello@fieldstay.app" className="text-[var(--mkt-ink)]/70 hover:text-[var(--mkt-ink)] transition-colors">
              hello@fieldstay.app
            </a>
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          FOOTER
      ══════════════════════════════════════════ */}
      <footer className="flex items-center justify-between px-8 py-7 bg-brand-900">
        <span className="font-display font-black text-base text-white">
          Field<span className="text-[var(--mkt-gold)]">Stay</span>
        </span>
        <div className="flex items-center gap-6">
          {[
            { label: 'hello@fieldstay.app', href: 'mailto:hello@fieldstay.app' },
            { label: 'Log In', href: loginHref },
            { label: 'Sign Up', href: ctaHref },
          ].map((l) => (
            <Link key={l.label} href={l.href} className="text-sm transition-colors text-white/40">
              {l.label}
            </Link>
          ))}
        </div>
      </footer>

    </div>
  )
}
