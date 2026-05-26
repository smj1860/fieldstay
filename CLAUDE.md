# CLAUDE.md — FieldStay

Read this entire file before writing any code or running any commands.

---

## Build Status — App Will Not Deploy Until Step 1 is Done

The Vercel build is failing because two config files were corrupted by a
GitHub upload — each contains the content of a React component instead of
its actual configuration. Fix these first before touching anything else.

---

## Step 1 — Fix Two Corrupted Config Files (CRITICAL)

### 1a — Replace tsconfig.json

The file currently contains `messages-form.tsx` content. Replace the entire
file with the correct TypeScript configuration:

**Replace entire contents of `tsconfig.json`:**

```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

### 1b — Replace next.config.ts

The file currently contains `new/page.tsx` content. Replace with the
correct Next.js configuration:

**Replace entire contents of `next.config.ts`:**

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Images from external sources can be added here if needed
}

export default nextConfig
```

### 1c — Upgrade Next.js (security vulnerability)

Next.js 15.3.0 has a known security vulnerability (CVE-2025-66478).
Upgrade to the latest patched version:

```bash
npm install next@latest
```

After running this, commit the updated `package.json` and
`package-lock.json`.

**Verify the build passes locally before continuing:**

```bash
npm run build
```

---

## Step 2 — Domain Change (fieldstay.com → fieldstay.app)

Update every reference from `fieldstay.com` to `fieldstay.app`.

### 2a — .env.example

```
# Change these two lines:
RESEND_FROM_EMAIL=noreply@fieldstay.app
NEXT_PUBLIC_APP_URL=https://app.fieldstay.app
```

### 2b — app/layout.tsx

Find the metadataBase line and update the fallback URL:

```ts
// Change from:
metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.com'),

// Change to:
metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'),
```

### 2c — Search and verify no other hardcoded references remain

Run this to confirm no other `.com` domain references exist:

```bash
grep -rn "fieldstay\.com" app/ lib/ components/ --include="*.ts" --include="*.tsx"
```

If any are found, update them to `fieldstay.app`.

---

## Step 3 — Stripe Pricing Overhaul

The current pricing structure (starter/growth/pro at 5/20/50 properties)
is completely wrong. It needs to be replaced with the new two-tier model
with both monthly and annual billing options.

**New pricing:**
| Plan | Properties | Monthly | Annual |
|------|-----------|---------|--------|
| Pro | Up to 15 | $149/mo | $1,490/yr |
| Growth | 16–45 | $219/mo | $2,190/yr |
| Enterprise | 45+ | Custom quote | Custom quote |

### 3a — Update lib/stripe/client.ts

**Replace the entire PLANS constant:**

```ts
export const PLANS = {
  pro: {
    name:             'Pro',
    monthlyPriceId:   process.env.STRIPE_PRICE_PRO_MONTHLY!,
    annualPriceId:    process.env.STRIPE_PRICE_PRO_ANNUAL!,
    maxProperties:    15,
    monthlyPrice:     149,
    annualPrice:      1490,
    description:      'Up to 15 properties',
  },
  growth: {
    name:             'Growth',
    monthlyPriceId:   process.env.STRIPE_PRICE_GROWTH_MONTHLY!,
    annualPriceId:    process.env.STRIPE_PRICE_GROWTH_ANNUAL!,
    maxProperties:    45,
    monthlyPrice:     219,
    annualPrice:      2190,
    description:      '16–45 properties',
  },
  enterprise: {
    name:             'Enterprise',
    monthlyPriceId:   null,
    annualPriceId:    null,
    maxProperties:    999,
    monthlyPrice:     null,
    annualPrice:      null,
    description:      '45+ properties — contact for pricing',
  },
} as const

export type PlanKey = keyof typeof PLANS
```

Also add a helper to look up a plan by any of its price IDs (used by the
webhook):

```ts
export function getPlanByPriceId(priceId: string): PlanKey | null {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (
      ('monthlyPriceId' in plan && plan.monthlyPriceId === priceId) ||
      ('annualPriceId'  in plan && plan.annualPriceId  === priceId)
    ) {
      return key as PlanKey
    }
  }
  return null
}
```

### 3b — Update .env.example

Replace the three old price ID variables with four new ones:

```bash
# Remove these:
# STRIPE_PRICE_STARTER=price_starter_id
# STRIPE_PRICE_GROWTH=price_growth_id
# STRIPE_PRICE_PRO=price_pro_id

# Add these:
STRIPE_PRICE_PRO_MONTHLY=price_pro_monthly_id
STRIPE_PRICE_PRO_ANNUAL=price_pro_annual_id
STRIPE_PRICE_GROWTH_MONTHLY=price_growth_monthly_id
STRIPE_PRICE_GROWTH_ANNUAL=price_growth_annual_id
```

### 3c — Update app/api/webhooks/stripe/route.ts

The webhook currently uses `PLANS[plan].maxProperties` but the plan lookup
needs to use the new `getPlanByPriceId` helper since each plan now has two
price IDs.

Find where the plan is determined from the subscription price and replace it:

```ts
import { stripe, PLANS, getPlanByPriceId } from '@/lib/stripe/client'

// Inside the subscription event handler, replace the plan lookup:
const priceId = subscription.items.data[0]?.price.id ?? ''
const planKey  = getPlanByPriceId(priceId) ?? 'pro'
const plan     = PLANS[planKey]

// Then use plan.maxProperties as before
```

### 3d — Update settings/actions.ts checkout action

The checkout action needs to accept a `billing_interval` parameter
(`monthly` or `annual`) and select the correct price ID:

```ts
export async function createCheckoutSession(
  _prev: SettingsActionState | null,
  formData: FormData
): Promise<SettingsActionState> {
  const { supabase, membership } = await requireOrgMember()

  const planKey  = formData.get('plan') as 'pro' | 'growth'
  const interval = (formData.get('billing_interval') as string) === 'annual'
    ? 'annual'
    : 'monthly'

  const planDef = PLANS[planKey]
  if (!planDef) return { error: 'Invalid plan' }

  const priceId = interval === 'annual'
    ? planDef.annualPriceId
    : planDef.monthlyPriceId

  if (!priceId) return { error: 'Plan not available' }

  const { data: org } = await supabase
    .from('organizations')
    .select('stripe_customer_id')
    .eq('id', membership.org_id)
    .single()

  const session = await stripe.checkout.sessions.create({
    mode:               'subscription',
    payment_method_types: ['card'],
    customer:           org?.stripe_customer_id ?? undefined,
    line_items:         [{ price: priceId, quantity: 1 }],
    success_url:        `${process.env.NEXT_PUBLIC_APP_URL}/settings?billing=success`,
    cancel_url:         `${process.env.NEXT_PUBLIC_APP_URL}/settings?billing=cancelled`,
    metadata:           { org_id: membership.org_id, plan: planKey },
  })

  if (!session.url) return { error: 'Could not create checkout session' }

  revalidatePath('/settings')
  return { redirectUrl: session.url }
}
```

### 3e — Update settings/settings-tabs.tsx billing section

Replace the `UPGRADE_PLANS` constant and billing UI with the new structure.

Remove:
```ts
const UPGRADE_PLANS = ['starter', 'growth', 'pro'] as const
```

Replace the billing/upgrade UI with plan cards that include:
- A **Monthly / Annual** toggle at the top of the billing section
- Two plan cards: **Pro** and **Growth**
- Annual shows the yearly total with "2 months free" note
- An **Enterprise** card with a "Contact Us" mailto link
- Each card's upgrade button submits the form with `plan` and
  `billing_interval` hidden inputs

```tsx
// Billing interval toggle state:
const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly')

// Plan cards:
const DISPLAY_PLANS = [
  {
    key:        'pro' as const,
    name:       'Pro',
    props:      'Up to 15 properties',
    monthly:    149,
    annual:     1490,
    color:      'brand',
  },
  {
    key:        'growth' as const,
    name:       'Growth',
    props:      '16–45 properties',
    monthly:    219,
    annual:     2190,
    color:      'brand',
  },
]
```

Render each card with:
- Plan name and property range
- Price: show `$149/mo` for monthly or `$1,490/yr` + `Save $298` for annual
- A "Get Started" button that calls the checkout action with the plan key
  and the current interval selection
- Enterprise card: "Contact Us" → `mailto:hello@fieldstay.app`

The form needs hidden inputs for `plan` and `billing_interval`:

```tsx
<form action={checkoutAction}>
  <input type="hidden" name="plan" value={plan.key} />
  <input type="hidden" name="billing_interval" value={interval} />
  <button type="submit" className="btn-primary w-full">
    Get Started
  </button>
</form>
```

Handle the `redirectUrl` response by redirecting:
```ts
if (state?.redirectUrl) {
  window.location.href = state.redirectUrl
}
```

---

## Step 4 — Public Landing Page

**File is missing entirely.** Create `app/page.tsx`.

Also update `middleware.ts` — add `'/'` to `PUBLIC_ROUTES`:

```ts
const PUBLIC_ROUTES = [
  '/',                     // ← ADD: landing page
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/crew/accept-invite',
]
```

**Create `app/page.tsx`:**

```tsx
import Link from 'next/link'
import { CalendarCheck, Package, Wrench, BarChart3, CheckCircle2, ArrowRight } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-accent-100 px-6 py-4 sticky top-0 bg-white/95 backdrop-blur z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="text-2xl font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-3">
            <Link href="/login" className="btn-ghost text-sm">Log In</Link>
            <Link href="/signup" className="btn-primary text-sm">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-24 text-center">
        <h1 className="text-5xl font-bold text-brand-800 leading-tight mb-5">
          STR Operations,<br />Finally Handled.
        </h1>
        <p className="text-xl text-accent-500 max-w-2xl mx-auto mb-8">
          FieldStay gives short-term rental property managers one platform
          for turnovers, inventory, maintenance, and owner reporting — with
          true offline access for your cleaning crew.
        </p>
        <Link href="/signup"
          className="btn-cta text-base px-8 py-3 inline-flex items-center gap-2">
          Start Free Trial <ArrowRight className="w-5 h-5" />
        </Link>
        <p className="text-sm text-accent-400 mt-3">
          14-day free trial · No credit card required
        </p>
      </section>

      {/* Features */}
      <section className="bg-accent-50 py-16">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-12">
            Everything between check-out and check-in
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
            {[
              { icon: CalendarCheck, title: 'Turnovers',   desc: 'Auto-generated from your Airbnb and VRBO calendars. Assign crew, track checklists, capture photos.' },
              { icon: Package,       title: 'Inventory',   desc: 'Par levels per property. Crew submits counts. Purchase orders generated and sent to you automatically.' },
              { icon: Wrench,        title: 'Maintenance', desc: 'Work orders, vendor portal, routine and seasonal schedule tracking — all in one place.' },
              { icon: BarChart3,     title: 'Owner P&L',   desc: 'Revenue from bookings, expenses from work orders. Owners get a clean, tokenized read-only portal.' },
            ].map((f) => (
              <div key={f.title} className="bg-white rounded-xl p-5 shadow-card">
                <f.icon className="w-7 h-7 text-brand-800 mb-3" />
                <h3 className="font-semibold text-accent-900 mb-1">{f.title}</h3>
                <p className="text-sm text-accent-500">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold text-brand-800 mb-10">
            Up and running in minutes
          </h2>
          <div className="space-y-6 text-left">
            {[
              { n: '1', title: 'Add your property',     desc: 'Name, address, check-in times, door codes, Wi-Fi — everything your crew and guests need.' },
              { n: '2', title: 'Connect your calendars', desc: 'Paste your Airbnb or VRBO iCal URL. FieldStay syncs bookings and generates turnovers automatically.' },
              { n: '3', title: 'Invite your crew',       desc: 'Crew gets an email link, creates an account, and sees their assignments on their phone — offline included.' },
            ].map((step) => (
              <div key={step.n} className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-gold-300 text-brand-800 font-bold
                                 text-sm flex items-center justify-center flex-shrink-0 mt-0.5">
                  {step.n}
                </span>
                <div>
                  <p className="font-semibold text-accent-900">{step.title}</p>
                  <p className="text-sm text-accent-500 mt-0.5">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-accent-50 py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-2">
            Simple, transparent pricing
          </h2>
          <p className="text-center text-accent-500 mb-10">
            Full software on every plan. No features gated.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                name:     'Pro',
                price:    '$149',
                annual:   '$1,490/yr',
                props:    'Up to 15 properties',
                highlight: false,
                features: ['All core features', 'Crew offline app', 'Inventory + POs', 'Owner P&L portal', 'Vendor portal'],
              },
              {
                name:     'Growth',
                price:    '$219',
                annual:   '$2,190/yr',
                props:    '16–45 properties',
                highlight: true,
                features: ['Everything in Pro', 'Up to 45 properties', 'Priority support'],
              },
              {
                name:     'Enterprise',
                price:    'Custom',
                annual:   '',
                props:    '45+ properties',
                highlight: false,
                features: ['Everything in Growth', 'Custom onboarding', 'Dedicated support', 'Volume pricing'],
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className={`bg-white rounded-xl p-6 shadow-card ${
                  plan.highlight ? 'ring-2 ring-brand-800' : ''
                }`}
              >
                {plan.highlight && (
                  <span className="inline-block bg-gold-300 text-brand-800 text-xs
                                   font-bold px-2 py-0.5 rounded-full mb-3">
                    Most Popular
                  </span>
                )}
                <h3 className="text-lg font-bold text-accent-900">{plan.name}</h3>
                <div className="my-2">
                  <span className="text-3xl font-bold text-brand-800">{plan.price}</span>
                  {plan.price !== 'Custom' && (
                    <span className="text-sm font-normal text-accent-400">/mo</span>
                  )}
                </div>
                {plan.annual && (
                  <p className="text-xs text-accent-400 mb-1">or {plan.annual} (save 2 months)</p>
                )}
                <p className="text-sm text-accent-500 mb-4">{plan.props}</p>
                <ul className="space-y-2 mb-5">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-accent-700">
                      <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                {plan.price === 'Custom' ? (
                  <a href="mailto:hello@fieldstay.app"
                     className="btn-secondary w-full text-center block py-2.5 text-sm">
                    Contact Us
                  </a>
                ) : (
                  <Link href="/signup"
                        className="btn-primary w-full text-center block py-2.5 text-sm">
                    Start Free Trial
                  </Link>
                )}
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-accent-400 mt-6">
            All plans include a 14-day free trial. No credit card required.
            Annual billing saves approximately 2 months.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-accent-100 py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between">
          <span className="font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-6 text-sm text-accent-400">
            <a href="mailto:hello@fieldstay.app" className="hover:text-accent-600">
              Contact
            </a>
            <Link href="/login"  className="hover:text-accent-600">Log In</Link>
            <Link href="/signup" className="hover:text-accent-600">Sign Up</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
```

---

## Step 5 — Review / Milestone Framework

Three parts are missing: the component, the API routes, and the dashboard
layout wiring.

### 5a — Create components/review-prompt.tsx

```tsx
'use client'
import { useState } from 'react'
import { Star, X } from 'lucide-react'

// Replace with real Google Place ID once Business Profile is verified.
// Temporary fallback: mailto link
const REVIEW_URL = 'mailto:feedback@fieldstay.app?subject=FieldStay Feedback'

export function ReviewPrompt({
  milestone,
  message,
  orgId,
}: {
  milestone: string
  message:   string
  orgId:     string
}) {
  const [hidden, setHidden] = useState(false)

  if (hidden) return null

  const handleReview = async () => {
    await fetch('/api/milestones/review-clicked', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ milestone, orgId }),
    })
    window.open(REVIEW_URL, '_blank', 'noopener,noreferrer')
    setHidden(true)
  }

  const handleDismiss = async () => {
    await fetch('/api/milestones/dismiss', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ milestone, orgId }),
    })
    setHidden(true)
  }

  return (
    <div className="flex items-center gap-3 bg-gold-50 border border-gold-300
                    rounded-xl px-4 py-3 mb-6">
      <Star className="w-5 h-5 text-gold-400 flex-shrink-0 fill-gold-300" />
      <p className="text-sm text-brand-800 flex-1">
        <span className="font-semibold">🎉 {message}</span>
        {' '}Would you mind leaving us a quick review?
      </p>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={handleReview} className="btn-cta text-xs px-3 py-1.5">
          Leave a Review
        </button>
        <button
          onClick={handleDismiss}
          className="text-accent-400 hover:text-accent-600 transition-colors p-1"
          title="Maybe later"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
```

### 5b — Create three milestone API routes

**New file: `app/api/milestones/seen/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const { milestone, orgId } = await request.json()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await supabase
    .from('org_milestones')
    .update({ prompted_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('milestone', milestone)

  return NextResponse.json({ success: true })
}
```

**New file: `app/api/milestones/dismiss/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const { milestone, orgId } = await request.json()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await supabase
    .from('org_milestones')
    .update({ dismissed: true })
    .eq('org_id', orgId)
    .eq('milestone', milestone)

  return NextResponse.json({ success: true })
}
```

**New file: `app/api/milestones/review-clicked/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const { milestone, orgId } = await request.json()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await supabase
    .from('org_milestones')
    .update({ review_clicked: true, dismissed: true })
    .eq('org_id', orgId)
    .eq('milestone', milestone)

  return NextResponse.json({ success: true })
}
```

### 5c — Wire into dashboard layout

**Edit: `app/(dashboard)/layout.tsx`**

After the `requireOrgMember()` call and membership check, add:

```ts
import { ReviewPrompt } from '@/components/review-prompt'

// After getting membership, fetch oldest un-prompted milestone:
const { data: pendingMilestone } = await supabase
  .from('org_milestones')
  .select('milestone, achieved_at')
  .eq('org_id', membership.org_id)
  .eq('dismissed', false)
  .is('prompted_at', null)
  .order('achieved_at', { ascending: true })
  .limit(1)
  .maybeSingle()

// Mark it as prompted so it won't show again on next load
if (pendingMilestone) {
  await supabase
    .from('org_milestones')
    .update({ prompted_at: new Date().toISOString() })
    .eq('org_id', membership.org_id)
    .eq('milestone', pendingMilestone.milestone)
}
```

Add milestone message map:

```ts
const MILESTONE_MESSAGES: Record<string, string> = {
  first_ical_sync:            'Your first bookings are syncing.',
  first_turnover_complete:    'First turnover done — FieldStay is working.',
  first_purchase_order:       'FieldStay just caught a restock before you ran out.',
  first_owner_portal_view:    'Your owner just viewed their P&L.',
  second_property_configured: 'You\'re managing multiple properties with FieldStay.',
  turnover_milestone_10:      '10 turnovers coordinated through FieldStay.',
  turnover_milestone_50:      '50 turnovers. That\'s serious volume.',
  thirty_days:                'You\'ve been running operations with FieldStay for a month.',
}
```

In the JSX, render the prompt above `{children}`:

```tsx
{pendingMilestone && MILESTONE_MESSAGES[pendingMilestone.milestone] && (
  <ReviewPrompt
    milestone={pendingMilestone.milestone}
    message={MILESTONE_MESSAGES[pendingMilestone.milestone]!}
    orgId={membership.org_id}
  />
)}
{children}
```

### 5d — Verify milestone recording in Inngest functions

Check that each of the following functions records its milestone.
If missing, add the `upsert` call (use `ignoreDuplicates: true` on the
`onConflict` so re-runs never double-record):

```ts
// Standard pattern — use this in every function:
await supabase.from('org_milestones').upsert(
  { org_id, milestone: 'MILESTONE_KEY' },
  { onConflict: 'org_id,milestone', ignoreDuplicates: true }
)
```

| File | Milestone key | Where to add |
|------|--------------|--------------|
| `lib/inngest/functions/ical-sync.ts` | `first_ical_sync` | After first successful sync for an org |
| `lib/inngest/functions/turnover-events.ts` | `first_turnover_complete` | When completed turnover count === 1 |
| `lib/inngest/functions/turnover-events.ts` | `turnover_milestone_10` | When completed turnover count === 10 |
| `lib/inngest/functions/turnover-events.ts` | `turnover_milestone_50` | When completed turnover count === 50 |
| `lib/inngest/functions/inventory-events.ts` | `first_purchase_order` | After first PO is created |
| `lib/inngest/functions/maintenance-check.ts` | `thirty_days` | In daily check, for orgs 30+ days old |
| `app/owner/[token]/page.tsx` | `first_owner_portal_view` | After token validated, before rendering |
| `app/(dashboard)/properties/actions.ts` | `second_property_configured` | When 2nd property completes all 7 setup steps |

---

## Step 6 — Vercel Environment Variables

In the Vercel project dashboard → **Settings** → **Environment Variables**,
update or add these values. Remove the old `STRIPE_PRICE_STARTER`,
`STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` variables and replace with:

```
STRIPE_PRICE_PRO_MONTHLY      = price_... (from Stripe dashboard)
STRIPE_PRICE_PRO_ANNUAL       = price_... (from Stripe dashboard)
STRIPE_PRICE_GROWTH_MONTHLY   = price_... (from Stripe dashboard)
STRIPE_PRICE_GROWTH_ANNUAL    = price_... (from Stripe dashboard)

NEXT_PUBLIC_APP_URL           = https://app.fieldstay.app
RESEND_FROM_EMAIL             = noreply@fieldstay.app
```

All other env vars remain the same.

---

## Step 7 — Stripe Dashboard Setup

Stephen has already created the $149/$1,490 and $219/$2,190 prices in
Stripe. Confirm these four price IDs exist and copy them into Vercel:

1. Pro — Monthly ($149/month recurring)
2. Pro — Annual ($1,490/year recurring)
3. Growth — Monthly ($219/month recurring)
4. Growth — Annual ($2,190/year recurring)

Update the webhook endpoint if it isn't already pointing to production:
- URL: `https://app.fieldstay.app/api/webhooks/stripe`
- Events: `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`

---

## External Configuration — PowerSync Sync Rules

**Not a code change — configure in PowerSync dashboard.**

1. Go to https://powersync.com → your FieldStay instance → **Sync Rules**
2. Paste and deploy:

```yaml
bucket_definitions:
  crew_turnovers:
    data:
      - table: turnovers
        where: >
          id IN (
            SELECT ta.turnover_id
            FROM turnover_assignments ta
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
              AND turnovers.checkout_datetime >= NOW() - INTERVAL '1 day'
          )

  crew_checklist_instances:
    data:
      - table: checklist_instances
        where: >
          turnover_id IN (
            SELECT ta.turnover_id
            FROM turnover_assignments ta
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )

  crew_checklist_items:
    data:
      - table: checklist_instance_items
        where: >
          instance_id IN (
            SELECT ci.id FROM checklist_instances ci
            JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )

  crew_inventory:
    data:
      - table: inventory_items
        where: >
          property_id IN (
            SELECT DISTINCT t.property_id FROM turnovers t
            JOIN turnover_assignments ta ON ta.turnover_id = t.id
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )
```

---

## Complete File Change Map

```
tsconfig.json                           REPLACE ENTIRE FILE (Step 1a)
next.config.ts                          REPLACE ENTIRE FILE (Step 1b)
package.json                            npm install next@latest (Step 1c)

.env.example                            EDIT: domain + stripe vars (Steps 2a, 3b)
app/layout.tsx                          EDIT: metadataBase URL (Step 2b)
middleware.ts                           EDIT: add '/' to PUBLIC_ROUTES (Step 4)

lib/stripe/client.ts                    REPLACE PLANS constant + add helper (Step 3a)
app/api/webhooks/stripe/route.ts        EDIT: use getPlanByPriceId (Step 3c)
app/(dashboard)/settings/actions.ts    EDIT: checkout with interval param (Step 3d)
app/(dashboard)/settings/settings-tabs.tsx  EDIT: billing UI with interval toggle (Step 3e)

app/page.tsx                            CREATE: landing page (Step 4)

components/review-prompt.tsx            CREATE (Step 5a)
app/api/milestones/seen/route.ts        CREATE (Step 5b)
app/api/milestones/dismiss/route.ts     CREATE (Step 5b)
app/api/milestones/review-clicked/route.ts  CREATE (Step 5b)
app/(dashboard)/layout.tsx              EDIT: milestone fetch + ReviewPrompt (Step 5c)
lib/inngest/functions/*.ts              EDIT: add milestone recording (Step 5d)
app/owner/[token]/page.tsx             EDIT: add portal view milestone (Step 5d)
app/(dashboard)/properties/actions.ts  EDIT: second property milestone (Step 5d)
```

---

## Code Patterns

### Auth
```ts
const { user, supabase, membership } = await requireOrgMember()
// Always filter every query by membership.org_id
```

### Service client — Inngest, webhooks, tokenized routes ONLY
```ts
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Bypasses RLS — never in dashboard pages or server actions
```

### Pre-built CSS
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta       ← gold (#FCD116) MUST use text-brand-800, never white text
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
```

### Brand tokens
```
bg-brand-800   = #102246  primary navy
bg-gold-300    = #FCD116  action yellow (dark text only)
bg-accent-50   = #F8F9FA  page backgrounds
text-accent-800 = #1A1D20 body text
```

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()`
3. Never forget `revalidatePath()` after mutations
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`
7. `.btn-cta` MUST use `text-brand-800` — never white text on gold

---

## Launch Checklist

- [ ] `npm run build` passes locally after Steps 1–5
- [ ] Vercel build passes (check deploy log)
- [ ] `fieldstay.app` domain added in Vercel → DNS updated at Namecheap
- [ ] `app.fieldstay.app` subdomain added in Vercel
- [ ] SSL auto-provisioned by Vercel (no Namecheap SSL needed)
- [ ] v2 migration run on production Supabase
- [ ] All 4 Stripe price IDs in Vercel env vars
- [ ] Stripe webhook pointing to `https://app.fieldstay.app/api/webhooks/stripe`
- [ ] Resend domain `fieldstay.app` verified
- [ ] PowerSync sync rules deployed
- [ ] Inngest functions visible at https://app.fieldstay.app/api/inngest
