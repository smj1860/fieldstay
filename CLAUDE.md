# CLAUDE.md — FieldStay

Read this entire file before writing any code or running any commands.

---

## Current State — Phase 1 Complete

**107 source files. The full product is built and working.**

| Area | Status |
|------|--------|
| Auth — signup, login, onboarding | ✅ Complete |
| Properties CRUD + 7-step setup wizard | ✅ Complete |
| Turnovers board + detail + crew assignment | ✅ Complete |
| Checklist instances auto-created on turnover generation | ✅ Complete |
| Checklist builder with bulk + per-section photo toggles | ✅ Complete |
| Inventory management + catalog picker + PO history | ✅ Complete |
| Maintenance — work order board + detail + schedule tracking | ✅ Complete |
| Communications — sent guest message log | ✅ Complete |
| Owners — add owners, portal links, P&L transaction management | ✅ Complete |
| Settings — org, crew, vendors, Stripe billing | ✅ Complete |
| Owner portal — tokenized P&L view | ✅ Complete |
| Vendor portal — tokenized work order completion | ✅ Complete |
| Booking revenue auto-created from iCal (nights × avg_nightly_rate) | ✅ Complete |
| WO expense auto-created on completion | ✅ Complete |
| Crew app — PowerSync offline (dashboard, checklist, photo capture) | ✅ Complete |
| Crew invite flow — email invite + accept-invite pages | ✅ Complete |
| Inngest pipeline — 10 functions, all registered | ✅ Complete |
| Brand colors (#102246 navy, #FCD116 gold) | ✅ Complete |
| Migrations v1 + v2 (with invite fields + org_milestones table) | ✅ Complete |

---

## Phase 2 — What to Build Next

Two features remain before the product is ready for public launch:

1. **Review / Milestone Framework** — track PM wins, surface a prompt
   asking for a review at the right moment
2. **Public Landing Page** — `fieldstay.com` marketing page for signups

Build in this order.

---

## Build 1 — Review / Milestone Framework

The `org_milestones` table already exists (created in v2 migration).
Nothing populates it yet, and no UI exists.

### How it works

Inngest functions silently record milestones as PMs use the product.
The dashboard layout checks for any un-prompted milestone and shows
a slim, dismissible banner — never a modal, never blocking work.
One prompt at a time, oldest first. PM clicks "Leave a Review" or
"Maybe later" — both clear the prompt.

### Milestones to track

| Milestone key | When to record | Prompt message |
|---------------|---------------|----------------|
| `first_ical_sync` | After first successful iCal sync for an org | "Your first bookings are syncing." |
| `first_turnover_complete` | When first turnover reaches `completed` status | "First turnover done — FieldStay is working." |
| `first_purchase_order` | When first PO is generated for an org | "FieldStay just caught a restock before you ran out." |
| `first_owner_portal_view` | When owner portal token is accessed for first time | "Your owner just viewed their P&L." |
| `second_property_configured` | When second property completes setup wizard | "You're managing multiple properties with FieldStay." |
| `turnover_milestone_10` | When 10th turnover is completed for the org | "10 turnovers coordinated through FieldStay." |
| `turnover_milestone_50` | When 50th turnover is completed | "50 turnovers. That's serious volume." |
| `thirty_days` | 30 days after org `created_at` | "You've been running operations with FieldStay for a month." |

### Step 1a — Record milestones in Inngest functions

Add milestone recording to the relevant functions. Use `upsert` with
`ignoreDuplicates: true` so re-runs never double-record.

**Edit:** `lib/inngest/functions/ical-sync.ts`

In `syncIcalFeed`, inside the `mark-sync-success` step, add after the
feed status update:

```ts
// Record first-sync milestone for this org
await supabase.from('org_milestones').upsert(
  { org_id, milestone: 'first_ical_sync' },
  { onConflict: 'org_id,milestone', ignoreDuplicates: true }
)
```

**Edit:** `lib/inngest/functions/turnover-events.ts`

In `handleTurnoverCompleted`, add a step after the PM notification:

```ts
await step.run('record-completion-milestones', async () => {
  const supabase = createServiceClient()

  // Count total completed turnovers for this org
  const { count } = await supabase
    .from('turnovers')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', org_id)
    .eq('status', 'completed')

  const n = count ?? 0

  // First ever completion
  if (n === 1) {
    await supabase.from('org_milestones').upsert(
      { org_id, milestone: 'first_turnover_complete' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    )
  }
  // 10th turnover
  if (n === 10) {
    await supabase.from('org_milestones').upsert(
      { org_id, milestone: 'turnover_milestone_10' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    )
  }
  // 50th turnover
  if (n === 50) {
    await supabase.from('org_milestones').upsert(
      { org_id, milestone: 'turnover_milestone_50' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    )
  }
})
```

**Edit:** `lib/inngest/functions/inventory-events.ts`

In `handleInventoryCountSubmitted`, after the PO is created and sent:

```ts
// Record first PO milestone
await supabase.from('org_milestones').upsert(
  { org_id, milestone: 'first_purchase_order' },
  { onConflict: 'org_id,milestone', ignoreDuplicates: true }
)
```

**Edit:** `lib/inngest/functions/maintenance-check.ts`

In `dailyMaintenanceCheck`, inside the daily run, add a check for
the 30-day milestone:

```ts
await step.run('check-thirty-day-milestone', async () => {
  const supabase = createServiceClient()

  // Find orgs that are 30+ days old and haven't hit this milestone yet
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .lte('created_at', thirtyDaysAgo)

  for (const org of orgs ?? []) {
    await supabase.from('org_milestones').upsert(
      { org_id: org.id, milestone: 'thirty_days' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    )
  }
})
```

**Edit:** `app/owner/[token]/page.tsx`

After recording `last_accessed_at`, also record the milestone:

```ts
// Record owner portal view milestone
const supabase = createServiceClient()
await supabase.from('org_milestones').upsert(
  { org_id: owner.org_id, milestone: 'first_owner_portal_view' },
  { onConflict: 'org_id,milestone', ignoreDuplicates: true }
)
```

**Edit:** `app/(dashboard)/properties/actions.ts`

In `markStepComplete`, when all steps are done for a property, check
if this is the second fully configured property for the org:

```ts
// After marking step complete — check for second_property_configured milestone
const allSteps = ['details','ical','inventory','messages','checklist','maintenance','crew']
const isFullySetup = allSteps.every((s) => updated[s] === true)

if (isFullySetup) {
  // Count fully configured properties for this org
  const { data: props } = await supabase
    .from('properties')
    .select('id, setup_steps_completed')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

  const fullyConfigured = (props ?? []).filter((p) => {
    const steps = p.setup_steps_completed as Record<string, boolean>
    return allSteps.every((s) => steps[s] === true)
  })

  if (fullyConfigured.length === 2) {
    await supabase.from('org_milestones').upsert(
      { org_id: membership.org_id, milestone: 'second_property_configured' },
      { onConflict: 'org_id,milestone', ignoreDuplicates: true }
    )
  }
}
```

### Step 1b — Milestone prompt API routes

**New file:** `app/api/milestones/seen/route.ts`

Called when a prompt is displayed — marks it as prompted so it doesn't
show again immediately.

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

**New file:** `app/api/milestones/dismiss/route.ts`

Called when PM clicks "Maybe later" or closes the prompt.

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

**New file:** `app/api/milestones/review-clicked/route.ts`

Called when PM clicks "Leave a Review" — records the click for tracking.

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

### Step 1c — Review prompt component

**New file:** `components/review-prompt.tsx`

```tsx
'use client'
import { useState } from 'react'
import { Star, X } from 'lucide-react'

// Update this URL once the Google Business profile is set up
const REVIEW_URL = 'https://g.page/r/FIELDSTAY_GOOGLE_PLACE_ID/review'

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

  const markSeen = () =>
    fetch('/api/milestones/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone, orgId }),
    })

  const handleReview = async () => {
    await fetch('/api/milestones/review-clicked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone, orgId }),
    })
    window.open(REVIEW_URL, '_blank', 'noopener,noreferrer')
    setHidden(true)
  }

  const handleDismiss = async () => {
    await fetch('/api/milestones/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone, orgId }),
    })
    setHidden(true)
  }

  // Mark as seen on first render
  useState(() => { markSeen() })

  return (
    <div className="flex items-center gap-3 bg-gold-50 border border-gold-300
                    rounded-xl px-4 py-3 mb-6 animate-fade-in">
      <Star className="w-5 h-5 text-gold-400 flex-shrink-0 fill-gold-300" />
      <p className="text-sm text-brand-800 flex-1">
        <span className="font-semibold">🎉 {message}</span>
        {' '}Would you mind leaving us a quick review?
      </p>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleReview}
          className="btn-cta text-xs px-3 py-1.5"
        >
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

### Step 1d — Wire into dashboard layout

**Edit:** `app/(dashboard)/layout.tsx`

In the server component, after getting the membership, fetch any
pending (un-prompted, un-dismissed) milestone:

```ts
// Fetch the oldest un-prompted milestone for this org
const { data: pendingMilestone } = await supabase
  .from('org_milestones')
  .select('milestone, achieved_at')
  .eq('org_id', membership.org_id)
  .eq('dismissed', false)
  .is('prompted_at', null)
  .order('achieved_at', { ascending: true })
  .limit(1)
  .maybeSingle()
```

Pass it to the layout and render the prompt above the page content.

The milestone → message map (define as a constant in the layout file):

```ts
const MILESTONE_MESSAGES: Record<string, string> = {
  first_ical_sync:             'Your first bookings are syncing.',
  first_turnover_complete:     'First turnover done — FieldStay is working.',
  first_purchase_order:        'FieldStay just caught a restock before you ran out.',
  first_owner_portal_view:     'Your owner just viewed their P&L.',
  second_property_configured:  'You\'re managing multiple properties with FieldStay.',
  turnover_milestone_10:       '10 turnovers coordinated through FieldStay.',
  turnover_milestone_50:       '50 turnovers. That\'s serious volume.',
  thirty_days:                 'You\'ve been running operations with FieldStay for a month.',
}
```

In the layout JSX, render it inside the main content area before `{children}`:

```tsx
{pendingMilestone && MILESTONE_MESSAGES[pendingMilestone.milestone] && (
  <ReviewPrompt
    milestone={pendingMilestone.milestone}
    message={MILESTONE_MESSAGES[pendingMilestone.milestone]}
    orgId={membership.org_id}
  />
)}
{children}
```

Import `ReviewPrompt` from `@/components/review-prompt`.

---

## Build 2 — Public Landing Page

A simple, clean marketing page at `fieldstay.com` (root `/`) for
property managers to discover and sign up for FieldStay.

### Update middleware to allow root route

**Edit:** `middleware.ts`

Add `'/'` to `PUBLIC_ROUTES` so unauthenticated visitors can see the
landing page instead of being redirected to `/login`:

```ts
const PUBLIC_ROUTES = [
  '/',                      // ← ADD: landing page
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/crew/accept-invite',
]
```

Also update the authenticated redirect so logged-in users hitting `/`
go to `/properties` (not back to the landing page):

```ts
// Already-authenticated user hitting public route
if (user && isPublic && pathname !== '/') {
  // Don't redirect from landing — let them see it if they want
  // Only redirect from /login, /signup etc.
  if (pathname !== '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/properties'
    url.search   = ''
    return NextResponse.redirect(url)
  }
}
```

### Create the landing page

**New file:** `app/page.tsx`

Landing page content to include:
- Navigation bar: FieldStay logo + "Log In" + "Start Free Trial" buttons
- Hero: headline, subheadline, CTA button → `/signup`
- Feature highlights (3–4 key features)
- How it works (3 steps)
- Pricing summary (Starter / Growth / Pro)
- Footer

```tsx
import Link from 'next/link'
import {
  CalendarCheck, Package, Wrench, BarChart3,
  CheckCircle2, ArrowRight
} from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-accent-100 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="text-2xl font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-3">
            <Link href="/login" className="btn-ghost text-sm">Log In</Link>
            <Link href="/signup" className="btn-primary text-sm">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-20 text-center">
        <h1 className="text-5xl font-bold text-brand-800 leading-tight mb-4">
          STR Operations,<br />Finally Handled.
        </h1>
        <p className="text-xl text-accent-500 max-w-2xl mx-auto mb-8">
          FieldStay gives short-term rental property managers one platform for
          turnovers, inventory, maintenance, and owner reporting — with offline
          access for your cleaning crew.
        </p>
        <Link href="/signup" className="btn-cta text-base px-8 py-3 inline-flex items-center gap-2">
          Start Free Trial <ArrowRight className="w-5 h-5" />
        </Link>
        <p className="text-sm text-accent-400 mt-3">14-day free trial · No credit card required</p>
      </section>

      {/* Features */}
      <section className="bg-accent-50 py-16">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-12">
            Everything you need to run the back of house
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { icon: CalendarCheck, title: 'Turnovers', desc: 'Auto-generated from your Airbnb and VRBO calendars. Assign crew, track checklists.' },
              { icon: Package,       title: 'Inventory',  desc: 'Par levels per property. Crew submits counts. Purchase orders sent to you automatically.' },
              { icon: Wrench,        title: 'Maintenance', desc: 'Work orders, vendor portal, routine and seasonal schedule tracking.' },
              { icon: BarChart3,     title: 'Owner P&L',  desc: 'Revenue from bookings, expenses from work orders. Owners get a clean read-only portal.' },
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
              { n: '1', title: 'Add your property', desc: 'Name, address, check-in times, door codes, Wi-Fi — all in one place.' },
              { n: '2', title: 'Connect your calendars', desc: 'Paste your Airbnb or VRBO iCal URL. FieldStay syncs bookings and auto-generates turnovers.' },
              { n: '3', title: 'Invite your crew', desc: 'Crew gets a link, creates an account, and sees their assignments on their phone — even offline.' },
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
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-10">
            Simple pricing
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              { name: 'Starter',    price: '$XX',  props: 'Up to 5 properties',   features: ['All core features', 'Crew app', 'Guest messaging', 'Owner portal'] },
              { name: 'Growth',     price: '$XX',  props: 'Up to 20 properties',  features: ['Everything in Starter', 'Priority support'] },
              { name: 'Pro',        price: '$XX',  props: 'Up to 50 properties',  features: ['Everything in Growth', 'Dedicated onboarding'] },
            ].map((plan, i) => (
              <div key={plan.name} className={`bg-white rounded-xl p-6 shadow-card ${i === 1 ? 'ring-2 ring-brand-800' : ''}`}>
                {i === 1 && (
                  <span className="badge bg-gold-300 text-brand-800 font-semibold text-xs mb-3 inline-block">
                    Most Popular
                  </span>
                )}
                <h3 className="text-lg font-bold text-accent-900">{plan.name}</h3>
                <p className="text-3xl font-bold text-brand-800 my-2">
                  {plan.price}<span className="text-sm font-normal text-accent-400">/mo</span>
                </p>
                <p className="text-sm text-accent-500 mb-4">{plan.props}</p>
                <ul className="space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-accent-700">
                      <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/signup" className="btn-primary w-full text-center mt-5 block py-2.5 text-sm">
                  Start Free Trial
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-accent-400 mt-6">
            All plans include a 14-day free trial.
            Need more than 50 properties?{' '}
            <a href="mailto:hello@fieldstay.com" className="text-brand-700 hover:underline">
              Contact us
            </a>
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-accent-100 py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between">
          <span className="font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-6 text-sm text-accent-400">
            <a href="mailto:hello@fieldstay.com" className="hover:text-accent-600">Contact</a>
            <Link href="/login" className="hover:text-accent-600">Log In</Link>
            <Link href="/signup" className="hover:text-accent-600">Sign Up</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
```

**Note:** Replace `$XX` pricing with actual amounts once decided.
Replace `FIELDSTAY_GOOGLE_PLACE_ID` in `components/review-prompt.tsx`
with the real ID once the Google Business profile is set up.

---

## External Configuration — PowerSync Sync Rules

**This is NOT a code change.** This must be done manually in the
PowerSync dashboard. Claude Code cannot do this.

### Where to configure

1. Go to https://powersync.com → log in → open your FieldStay instance
2. Left sidebar → **Sync Rules**
3. Replace all existing content with the YAML below
4. Click **Deploy**

### Sync rules YAML

```yaml
bucket_definitions:
  # Turnovers assigned to this crew member
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

  # Checklist instances for those turnovers
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

  # Checklist items for those instances
  crew_checklist_items:
    data:
      - table: checklist_instance_items
        where: >
          instance_id IN (
            SELECT ci.id
            FROM checklist_instances ci
            JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )

  # Inventory items for properties the crew member is assigned to
  crew_inventory:
    data:
      - table: inventory_items
        where: >
          property_id IN (
            SELECT DISTINCT t.property_id
            FROM turnovers t
            JOIN turnover_assignments ta ON ta.turnover_id = t.id
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )
```

### After deploying

`token_parameters.user_id` is the Supabase Auth user ID from the JWT.
PowerSync receives it automatically from the `SupabaseConnector` in
`lib/powersync/client.ts` when crew log in on their devices.

**Verify it's working:**
1. PowerSync dashboard → **Diagnostics** → look for connected clients
2. On a crew device, log in at `/crew` — assignments should load and
   remain available without internet after the first sync

---

## External Configuration — Stripe Setup

**Not code — configure in Stripe dashboard.**

1. Go to https://dashboard.stripe.com → Products → Add product
2. Create three products:
   - **FieldStay Starter** — monthly price → copy price ID → `STRIPE_PRICE_STARTER`
   - **FieldStay Growth** — monthly price → copy price ID → `STRIPE_PRICE_GROWTH`
   - **FieldStay Pro** — monthly price → copy price ID → `STRIPE_PRICE_PRO`
3. Add a webhook endpoint:
   - URL: `https://app.fieldstay.com/api/webhooks/stripe`
   - Events to listen for:
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
   - Copy the signing secret → `STRIPE_WEBHOOK_SECRET`

---

## External Configuration — Resend Domain

**Not code — configure in Resend dashboard.**

1. Go to https://resend.com → Domains → Add Domain → `fieldstay.com`
2. Add the DNS records shown to your domain registrar
3. Wait for verification (usually under 30 minutes)
4. Update `RESEND_FROM_EMAIL` in production env vars to `noreply@fieldstay.com`

---

## Deployment — Vercel

1. Go to https://vercel.com → Add New Project → import from GitHub
2. Set environment variables (all from `.env.example`):
   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   INNGEST_EVENT_KEY
   INNGEST_SIGNING_KEY
   RESEND_API_KEY
   RESEND_FROM_EMAIL         = noreply@fieldstay.com
   RESEND_FROM_NAME          = FieldStay
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
   STRIPE_SECRET_KEY
   STRIPE_WEBHOOK_SECRET
   STRIPE_PRICE_STARTER
   STRIPE_PRICE_GROWTH
   STRIPE_PRICE_PRO
   NEXT_PUBLIC_POWERSYNC_URL
   NEXT_PUBLIC_APP_URL       = https://app.fieldstay.com
   ```
3. Deploy
4. Set custom domain: `app.fieldstay.com` → Vercel project
5. Run v2 migration on production Supabase project (if not already done)
6. Configure PowerSync sync rules (above)
7. Create Stripe products and webhook endpoint pointing to production URL

---

## Repository Structure (Complete)

```
fieldstay/
├── middleware.ts                         ✅ + landing page in PUBLIC_ROUTES (Build 2)
├── fieldstay_migration_v1.sql            ✅ Run on production Supabase
├── fieldstay_migration_v2.sql            ✅ Run on production Supabase
│
├── components/
│   └── review-prompt.tsx                 ← CREATE (Build 1c)
│
├── lib/
│   ├── inngest/functions/
│   │   ├── ical-sync.ts                  ✅ + milestone recording (Build 1a)
│   │   ├── booking-events.ts             ✅
│   │   ├── turnover-events.ts            ✅ + milestone recording (Build 1a)
│   │   ├── inventory-events.ts           ✅ + milestone recording (Build 1a)
│   │   ├── maintenance-check.ts          ✅ + 30-day milestone (Build 1a)
│   │   └── work-order-events.ts          ✅
│   └── [all other lib files]             ✅ No changes
│
├── app/
│   ├── page.tsx                          ← CREATE: landing page (Build 2)
│   ├── (dashboard)/
│   │   ├── layout.tsx                    ✅ + milestone fetch + ReviewPrompt (Build 1d)
│   │   ├── properties/actions.ts         ✅ + second_property_configured (Build 1a)
│   │   └── [all other dashboard files]   ✅ No changes
│   ├── owner/[token]/page.tsx            ✅ + owner portal view milestone (Build 1a)
│   └── api/
│       └── milestones/
│           ├── seen/route.ts             ← CREATE (Build 1b)
│           ├── dismiss/route.ts          ← CREATE (Build 1b)
│           └── review-clicked/route.ts   ← CREATE (Build 1b)
```

---

## Code Patterns

### Auth (every server component + server action)
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

### Crew pages — PowerSync (offline-capable)
```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])
const db = usePowerSync()
await db.execute('UPDATE ... SET ... WHERE id = ?', [value, id])
```

### Pre-built CSS (use before writing custom Tailwind)
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta                     ← gold (#FCD116), MUST use text-brand-800 (never white)
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
.section-header  .page-title  .page-subtitle  .page-header
```

### Brand tokens
```
bg-brand-800    = #102246  primary navy
bg-gold-300     = #FCD116  action yellow
bg-accent-50    = #F8F9FA  page backgrounds
text-accent-800 = #1A1D20  body text
```

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()` (validates JWT server-side)
3. Never forget `revalidatePath()` after mutations
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`
7. `.btn-cta` MUST use `text-brand-800` — never white text on gold

---

## Database Reference

```
organizations → organization_members → auth.users
             → org_milestones
             → properties (avg_nightly_rate)
                  → ical_feeds → bookings → turnovers
                  │                └── turnover_assignments → crew_members (invite fields)
                  │                └── checklist_instances → checklist_instance_items
                  → inventory_items → inventory_counts → inventory_count_items
                  → purchase_orders → purchase_order_items
                  → work_orders → work_order_updates, work_order_photos
                  → maintenance_schedules
                  → guest_message_templates → guest_messages_sent
                  → property_owners → owner_portal_tokens
                  └── owner_transactions (booking_id, work_order_id)
```

---

## Inngest Pipeline (Complete — 10 functions)

```
cron (4h)   → iCal sync → bookings + turnovers + checklist instances
                         + booking revenue transactions
                         + first_ical_sync milestone
cron (8am)  → maintenance check → alerts or auto WOs
                                 + thirty_days milestone check
booking     → confirmation email → sleepUntil → pre-checkout email
turnover    → crew notification → sleepUntil 24h → unassigned warning
            → on complete → PM notification + completion milestones
count       → apply quantities → below par → PO + PM email + first_po milestone
work order  → vendor portal link → on complete → PM alert + expense transaction
```

---

## Verification Checklist

After completing Phase 2 builds:

**Review framework:**
- [ ] Trigger an iCal sync → check `org_milestones` table in Supabase
  for `first_ical_sync` row
- [ ] Complete a turnover from the PM dashboard → `first_turnover_complete`
  row appears
- [ ] Refresh dashboard → gold review prompt banner appears at top
- [ ] Click "Maybe later" → prompt disappears, `dismissed = true` in DB
- [ ] New milestone fires → new prompt appears on next visit

**Landing page:**
- [ ] Visit `http://localhost:3000` while logged out → landing page renders
- [ ] Visit while logged in → landing page still renders (no redirect)
- [ ] "Start Free Trial" → goes to `/signup`
- [ ] "Log In" → goes to `/login`

**PowerSync (external config):**
- [ ] Sync rules deployed in PowerSync dashboard
- [ ] Crew member logs in on mobile → assignments load
- [ ] Turn off Wi-Fi → assignments still visible
- [ ] Check off a task → syncs to Supabase when Wi-Fi returns

**Production deployment:**
- [ ] v2 migration run on production Supabase
- [ ] All env vars set in Vercel
- [ ] Stripe webhook active and pointing to production URL
- [ ] Resend domain verified for `fieldstay.com`
- [ ] `app.fieldstay.com` resolves to Vercel deployment-- Safe to re-run — all statements are idempotent

-- avg_nightly_rate on properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- booking_id on owner_transactions
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id
  ON owner_transactions(booking_id);

-- Crew invite fields
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS invite_token       uuid UNIQUE DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS invite_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_crew_members_invite_token
  ON crew_members(invite_token);

-- Milestones table (review prompt framework — phase 2 feature)
CREATE TABLE IF NOT EXISTS org_milestones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  milestone      text NOT NULL,
  achieved_at    timestamptz NOT NULL DEFAULT NOW(),
  prompted_at    timestamptz,
  review_clicked boolean NOT NULL DEFAULT false,
  dismissed      boolean NOT NULL DEFAULT false,
  UNIQUE(org_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_org_milestones_org_id
  ON org_milestones(org_id);
```

Then run this file in Supabase SQL Editor.

---

## Step 2 — Add invite_sent_at to types/database.ts

**Edit:** `types/database.ts`

In the `CrewMember` interface, `invite_sent_at` is missing. Add it:

```ts
// CrewMember interface should have all three:
invite_token:        string | null
invite_sent_at:      string | null   // ← ADD THIS
invite_accepted_at:  string | null
```

---

## Step 3 — Checklist Builder: Bulk Photo Toggle

The checklist builder has a per-item camera icon toggle for `requires_photo`
but no bulk controls. PMs need to require photos for an entire section
(e.g. "all final walkthrough items") or the whole checklist at once.

**Edit:** `app/(dashboard)/properties/[id]/setup/checklist/checklist-builder.tsx`

### 3a — Add bulk toggle logic

After the existing state declarations (`useState`, `useTransition` calls),
add these two helper functions inside the `ChecklistBuilder` component:

```ts
// Toggle ALL items across ALL sections
const toggleAllPhotos = () => {
  const totalItems    = sections.reduce((n, s) => n + s.items.length, 0)
  const photoItems    = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
  const newValue      = !(totalItems > 0 && photoItems === totalItems)
  setSections((prev) => prev.map((s) => ({
    ...s,
    items: s.items.map((item) => ({ ...item, requires_photo: newValue })),
  })))
}

// Toggle ALL items in a single section
const toggleSectionPhotos = (sectionTempId: string) => {
  setSections((prev) => prev.map((s) => {
    if (s.tempId !== sectionTempId) return s
    const newValue = !s.items.every((i) => i.requires_photo)
    return { ...s, items: s.items.map((item) => ({ ...item, requires_photo: newValue })) }
  }))
}
```

### 3b — Global toggle bar

Add this block immediately after the title/description of the checklist
builder and before the sections list (before the `sections.map(...)` call):

```tsx
{/* Global photo requirement toggle */}
{sections.some((s) => s.items.length > 0) && (() => {
  const totalItems  = sections.reduce((n, s) => n + s.items.length, 0)
  const photoItems  = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
  const allOn       = totalItems > 0 && photoItems === totalItems

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-accent-50
                    rounded-xl border border-accent-200 mb-4">
      <div className="flex items-center gap-2">
        <Camera className="w-4 h-4 text-accent-500" />
        <div>
          <p className="text-sm font-medium text-accent-700">
            Require photo proof for all tasks
          </p>
          <p className="text-xs text-accent-400">
            {photoItems} of {totalItems} tasks require a photo
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={toggleAllPhotos}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full',
          'border-2 border-transparent transition-colors duration-200 focus:outline-none',
          allOn ? 'bg-brand-800' : 'bg-accent-300'
        )}
        role="switch"
        aria-checked={allOn}
      >
        <span className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow',
          'transform transition-transform duration-200',
          allOn ? 'translate-x-5' : 'translate-x-0'
        )} />
      </button>
    </div>
  )
})()}
```

### 3c — Per-section camera toggle

In the section header row (the `div` containing the section name input and
the up/down/delete buttons), add a section-level camera toggle button.
Insert it between the section name input and the move/delete controls:

```tsx
{/* Section photo toggle — inside section header div, before up/down buttons */}
{(() => {
  const sectionAllPhoto = section.items.length > 0 &&
    section.items.every((i) => i.requires_photo)
  return (
    <button
      type="button"
      onClick={() => toggleSectionPhotos(section.tempId)}
      title={sectionAllPhoto
        ? 'Remove photo requirement for all items in this section'
        : 'Require photo for all items in this section'}
      className={cn(
        'p-1 rounded transition-colors',
        sectionAllPhoto
          ? 'text-brand-800 bg-brand-50'
          : 'text-accent-300 hover:text-accent-500'
      )}
    >
      <Camera className="w-3.5 h-3.5" />
    </button>
  )
})()}
```

Make sure `Camera` is imported from `lucide-react` (it likely already is).

---

## Step 4 — Crew Turnover Page: Real Photo Capture

The current `app/crew/turnovers/[id]/page.tsx` shows the camera icon as a
visual indicator only. It has no upload logic and `toggleItem` ignores
`requires_photo` entirely — crew can check off any item without a photo
even if one is required.

**Replace the entire file** `app/crew/turnovers/[id]/page.tsx` with:

```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { useState, useRef } from 'react'
import {
  ArrowLeft, Camera, CheckCircle2, Circle,
  Loader2, ImageIcon, AlertCircle,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

export default function CrewTurnoverPage() {
  const { id }   = useParams<{ id: string }>()
  const router   = useRouter()
  const db       = usePowerSync()
  const supabase = createClient()

  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null)
  const [uploadError, setUploadError]         = useState<string | null>(null)
  const [completing, setCompleting]           = useState(false)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Data fetching via PowerSync (offline-capable)
  const { data: turnovers } = usePowerSyncQuery(
    'SELECT * FROM turnovers WHERE id = ?', [id]
  )
  const turnover = turnovers?.[0]

  const { data: instances } = usePowerSyncQuery(
    'SELECT * FROM checklist_instances WHERE turnover_id = ?', [id]
  )
  const instance = instances?.[0]

  const { data: items } = usePowerSyncQuery(
    `SELECT * FROM checklist_instance_items
     WHERE instance_id = ?
     ORDER BY section_name, sort_order`,
    [instance?.id ?? '']
  )

  const completedCount  = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount      = items?.length ?? 0
  const pendingPhotos   = items?.filter(
    (i) => i.requires_photo && !i.photo_storage_path
  ) ?? []

  // Group items by section
  const sections = (items ?? []).reduce<Record<string, NonNullable<typeof items>>>(
    (acc, item) => {
      if (!acc[item.section_name]) acc[item.section_name] = []
      acc[item.section_name]!.push(item)
      return acc
    },
    {}
  )

  // ── Toggle checklist item completion ────────────────────────────────────────
  const toggleItem = async (
    itemId: string,
    current: number,
    requiresPhoto: number,
    photoPath: string | null
  ) => {
    // Requires photo but none uploaded — trigger camera instead of toggling
    if (!current && requiresPhoto && !photoPath) {
      fileInputRefs.current[itemId]?.click()
      return
    }
    await db.execute(
      'UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?',
      [current ? 0 : 1, itemId]
    )
  }

  // ── Photo capture and upload ─────────────────────────────────────────────────
  // Photos REQUIRE an internet connection (offline photo queuing is phase 2).
  const handlePhotoCapture = async (itemId: string, file: File) => {
    setUploadingItemId(itemId)
    setUploadError(null)
    try {
      const ext  = file.name.split('.').pop() ?? 'jpg'
      const path = `turnover-${id}/${itemId}-${Date.now()}.${ext}`

      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(path, file, { contentType: file.type, upsert: true })

      if (error) throw new Error(error.message)

      // Update local PowerSync DB — connector syncs to Supabase when online
      await db.execute(
        `UPDATE checklist_instance_items
         SET photo_storage_path = ?, is_completed = 1
         WHERE id = ?`,
        [path, itemId]
      )
    } catch (err) {
      console.error('Photo upload failed:', err)
      setUploadError(
        'Photo upload failed. Make sure you have a connection and try again.'
      )
    } finally {
      setUploadingItemId(null)
    }
  }

  // ── Status actions ───────────────────────────────────────────────────────────
  const markInProgress = async () => {
    await db.execute(
      'UPDATE turnovers SET status = ? WHERE id = ?',
      ['in_progress', id]
    )
  }

  const markComplete = async () => {
    if (pendingPhotos.length > 0) {
      const ok = confirm(
        `${pendingPhotos.length} item${pendingPhotos.length !== 1 ? 's' : ''} ` +
        `still need photos. Mark complete anyway?`
      )
      if (!ok) return
    }
    setCompleting(true)
    await db.execute(
      'UPDATE turnovers SET status = ? WHERE id = ?',
      ['completed', id]
    )
    router.push('/crew')
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (!turnover) {
    return (
      <div className="text-center py-20 text-accent-400">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  return (
    <div>
      <Link
        href="/crew"
        className="flex items-center gap-1.5 text-sm text-accent-400
                   hover:text-accent-600 mb-4 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Assignments
      </Link>

      {/* Turnover info */}
      <div className="bg-white rounded-xl border border-accent-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            turnover.priority === 'urgent' ? 'bg-red-50 text-red-600' :
            turnover.priority === 'high'   ? 'bg-amber-50 text-amber-700' :
            'bg-accent-100 text-accent-600'
          )}>
            {turnover.priority} priority
          </span>
          {turnover.window_minutes && (
            <span className="text-sm font-semibold text-accent-600">
              {Math.floor(turnover.window_minutes / 60)}h
              {turnover.window_minutes % 60 > 0
                ? ` ${turnover.window_minutes % 60}m`
                : ''} window
            </span>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Checkout</span>
            <span className="font-medium text-accent-900">
              {formatDateTime(turnover.checkout_datetime)}
            </span>
          </div>
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-accent-900">
              {formatDateTime(turnover.checkin_datetime)}
            </span>
          </div>
        </div>
        {turnover.notes && (
          <p className="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
            📝 {turnover.notes}
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200
                        rounded-xl px-4 py-3 mb-4">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{uploadError}</p>
        </div>
      )}

      {/* Checklist progress */}
      {totalCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-semibold text-accent-700">
              Checklist — {completedCount} of {totalCount}
            </span>
            <span className="text-sm text-accent-400">
              {Math.round((completedCount / totalCount) * 100)}%
            </span>
          </div>
          <div className="h-2 bg-accent-200 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                completedCount === totalCount ? 'bg-green-500' : 'bg-brand-800'
              )}
              style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
            />
          </div>
          {pendingPhotos.length > 0 && (
            <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
              <Camera className="w-3 h-3" />
              {pendingPhotos.length} item{pendingPhotos.length !== 1 ? 's' : ''} still
              need{pendingPhotos.length === 1 ? 's' : ''} a photo
            </p>
          )}
        </div>
      )}

      {/* Sections */}
      {Object.entries(sections).map(([sectionName, sectionItems]) => (
        <div key={sectionName} className="mb-4">
          <h3 className="text-xs font-semibold text-accent-500 uppercase
                         tracking-wide mb-2 px-1">
            {sectionName}
          </h3>
          <div className="bg-white rounded-xl border border-accent-200
                          divide-y divide-accent-100 overflow-hidden">
            {sectionItems.map((item) => {
              const needsPhoto = item.requires_photo && !item.photo_storage_path
              const uploading  = uploadingItemId === item.id

              return (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3',
                    item.is_completed ? 'bg-green-50' : 'bg-white'
                  )}
                >
                  {/* Completion circle — tapping triggers photo if required */}
                  <button
                    className="flex-shrink-0 mt-0.5"
                    onClick={() => toggleItem(
                      item.id,
                      item.is_completed,
                      item.requires_photo,
                      item.photo_storage_path
                    )}
                  >
                    {item.is_completed
                      ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                      : <Circle className={cn(
                          'w-5 h-5',
                          needsPhoto ? 'text-amber-400' : 'text-accent-300'
                        )} />
                    }
                  </button>

                  {/* Task label */}
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-sm leading-snug',
                      item.is_completed
                        ? 'text-green-700 line-through'
                        : 'text-accent-800'
                    )}>
                      {item.task}
                    </p>
                    {item.notes && (
                      <p className="text-xs text-accent-400 mt-0.5">{item.notes}</p>
                    )}
                    {item.photo_storage_path && (
                      <p className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                        <ImageIcon className="w-3 h-3" />
                        Photo attached
                      </p>
                    )}
                    {needsPhoto && !uploading && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Photo required before completing
                      </p>
                    )}
                  </div>

                  {/* Camera button — only shown when requires_photo */}
                  {item.requires_photo && (
                    <div className="flex-shrink-0">
                      {uploading ? (
                        <div className="p-1.5">
                          <Loader2 className="w-4 h-4 text-accent-400 animate-spin" />
                        </div>
                      ) : (
                        <button
                          onClick={() => fileInputRefs.current[item.id]?.click()}
                          className={cn(
                            'p-1.5 rounded-lg transition-colors',
                            item.photo_storage_path
                              ? 'text-green-600 bg-green-50 hover:bg-green-100'
                              : 'text-amber-600 bg-amber-50 hover:bg-amber-100'
                          )}
                          title={
                            item.photo_storage_path
                              ? 'Replace photo'
                              : 'Tap to take required photo'
                          }
                        >
                          <Camera className="w-4 h-4" />
                        </button>
                      )}
                      {/*
                        Hidden file input.
                        capture="environment" triggers the rear camera on mobile.
                        On desktop it opens the file picker.
                      */}
                      <input
                        ref={(el) => { fileInputRefs.current[item.id] = el }}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handlePhotoCapture(item.id, file)
                          e.target.value = '' // reset so same file can be re-selected
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {totalCount === 0 && (
        <div className="bg-white rounded-xl border border-accent-200 p-6
                        text-center text-accent-400 text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3 pb-8 mt-4">
        {turnover.status === 'assigned' && (
          <button
            onClick={markInProgress}
            className="btn-secondary w-full py-3"
          >
            Start Turnover
          </button>
        )}
        <button
          onClick={markComplete}
          disabled={completing || turnover.status === 'completed'}
          className="btn-cta w-full py-3 flex items-center justify-center gap-2
                     disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {completing
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            : turnover.status === 'completed'
            ? '✓ Marked Complete'
            : 'Mark as Complete'
          }
        </button>
      </div>
    </div>
  )
}
```

---

## Step 5 — Crew Invite Flow

Crew members are added to the roster in Settings but have no way to log
in until they have a Supabase Auth account linked to `crew_members.user_id`.
This step builds the full invite flow.

### 5a — Update middleware.ts

**Edit:** `middleware.ts`

Add `/crew/accept-invite` to `PUBLIC_ROUTES`:

```ts
const PUBLIC_ROUTES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/crew/accept-invite',   // ← ADD THIS
]
```

### 5b — Add inviteCrewMember action to settings

**Edit:** `app/(dashboard)/settings/actions.ts`

Add this function (after existing exports):

```ts
export async function inviteCrewMember(
  crewMemberId: string
): Promise<{ error?: string; success?: boolean }> {
  const { supabase, membership } = await requireOrgMember()

  if (!['admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_token, user_id')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew)        return { error: 'Crew member not found' }
  if (!crew.email)  return { error: 'No email address on file for this crew member' }
  if (crew.user_id) return { error: 'This crew member already has an active account' }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew/accept-invite/${crew.invite_token}`

  const { resend, FROM } = await import('@/lib/resend/client')
  const { error: emailError } = await resend.emails.send({
    from:    FROM,
    to:      crew.email,
    subject: `You've been invited to join ${org?.name ?? 'FieldStay'}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#102246;margin-bottom:8px">
          You're invited to FieldStay
        </h2>
        <p style="color:#1A1D20">Hi ${crew.name},</p>
        <p style="color:#1A1D20">
          <strong>${org?.name ?? 'Your property manager'}</strong> has invited
          you to join their team on FieldStay — the app you'll use to view
          cleaning assignments, complete checklists, and submit inventory counts.
        </p>
        <p style="margin:28px 0">
          <a href="${inviteUrl}"
             style="background:#FCD116;color:#102246;padding:14px 28px;
                    text-decoration:none;border-radius:8px;font-weight:700;
                    display:inline-block;font-size:15px">
            Accept Invitation →
          </a>
        </p>
        <p style="color:#6C757D;font-size:13px">
          This link expires in 7 days. If you weren't expecting this, you can
          safely ignore it.
        </p>
      </div>
    `,
  })

  if (emailError) return { error: emailError.message }

  await supabase
    .from('crew_members')
    .update({ invite_sent_at: new Date().toISOString() })
    .eq('id', crewMemberId)

  revalidatePath('/settings')
  return { success: true }
}
```

### 5c — Add invite button to settings crew tab

**Edit:** `app/(dashboard)/settings/settings-tabs.tsx`

First, import `inviteCrewMember` at the top with the other action imports.

Update the `CrewMember` interface to include the new fields:

```ts
interface CrewMember {
  id:                  string
  name:                string
  email:               string | null
  phone:               string | null
  specialty:           string
  preferred_contact:   string
  is_active:           boolean
  user_id:             string | null
  invite_sent_at:      string | null
  invite_accepted_at:  string | null
}
```

Update the crew fetch in `app/(dashboard)/settings/page.tsx` to include
these fields:

```ts
.select(`id, name, email, phone, specialty, preferred_contact,
         is_active, user_id, invite_sent_at, invite_accepted_at`)
```

In the `CrewRow` component add these state declarations and the invite handler:

```tsx
const [inviting, setInviting]         = useState(false)
const [inviteSent, setInviteSent]     = useState(false)
const [inviteError, setInviteError]   = useState<string | null>(null)

const handleInvite = async () => {
  setInviting(true)
  setInviteError(null)
  const result = await inviteCrewMember(member.id)
  setInviting(false)
  if (result.error) {
    setInviteError(result.error)
  } else {
    setInviteSent(true)
  }
}
```

In the crew row JSX, add an invite status column. The logic:
- `user_id` is set → show green "Active" badge
- `invite_accepted_at` is set but no `user_id` → anomaly, show "Active"
- `inviteSent` just happened → show "✓ Invite sent"
- `invite_sent_at` is set (previously sent) → show "Resend invite" link
- None of the above → show "Invite to app" button

```tsx
{/* Status / invite column */}
<td className="py-2.5 pr-2">
  {member.user_id ? (
    <span className="text-xs text-green-600 font-medium flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
      Active
    </span>
  ) : inviteSent ? (
    <span className="text-xs text-brand-700 font-medium">✓ Invite sent</span>
  ) : member.invite_sent_at ? (
    <button
      onClick={handleInvite}
      disabled={inviting}
      className="text-xs text-accent-500 hover:text-accent-700 underline
                 underline-offset-2 disabled:opacity-50"
    >
      {inviting ? 'Sending…' : 'Resend invite'}
    </button>
  ) : (
    <button
      onClick={handleInvite}
      disabled={inviting}
      className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
    >
      {inviting ? 'Sending…' : 'Invite to app'}
    </button>
  )}
  {inviteError && (
    <p className="text-xs text-red-500 mt-0.5">{inviteError}</p>
  )}
</td>
```

### 5d — Accept invite landing page

**New file:** `app/crew/accept-invite/[token]/page.tsx`

```tsx
import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { AcceptInviteForm } from './accept-invite-form'

interface Props { params: { token: string } }

export default async function AcceptInvitePage({ params }: Props) {
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_sent_at, invite_accepted_at, user_id')
    .eq('invite_token', params.token)
    .single()

  if (!crew) notFound()

  // Already linked to an account
  if (crew.user_id || crew.invite_accepted_at) {
    return (
      <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <p className="text-3xl mb-3">✅</p>
          <h2 className="text-lg font-bold text-accent-900 mb-2">
            Account Already Active
          </h2>
          <p className="text-sm text-accent-500 mb-6">
            Your FieldStay account is set up. Log in to see your assignments.
          </p>
          <a href="/login" className="btn-primary w-full block text-center py-2.5">
            Go to Login →
          </a>
        </div>
      </div>
    )
  }

  // Check expiry (7 days from when invite was sent)
  if (crew.invite_sent_at) {
    const expired =
      new Date(crew.invite_sent_at).getTime() + 7 * 86_400_000 < Date.now()
    if (expired) {
      return (
        <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
            <p className="text-3xl mb-3">⏰</p>
            <h2 className="text-lg font-bold text-accent-900 mb-2">
              Invite Link Expired
            </h2>
            <p className="text-sm text-accent-500">
              This link has expired. Ask your property manager to send a new invite.
            </p>
          </div>
        </div>
      )
    }
  }

  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            FieldStay
          </h1>
          <p className="text-brand-200 text-sm mt-1">Crew App</p>
        </div>
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <h2 className="text-xl font-bold text-accent-900 mb-1">
            Welcome, {crew.name}
          </h2>
          <p className="text-sm text-accent-500 mb-6">
            Create a password to activate your account.
          </p>
          <AcceptInviteForm
            token={params.token}
            crewId={crew.id}
            email={crew.email ?? ''}
            name={crew.name}
          />
        </div>
      </div>
    </div>
  )
}
```

**New file:** `app/crew/accept-invite/[token]/accept-invite-form.tsx`

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function AcceptInviteForm({
  token,
  crewId,
  email,
  name,
}: {
  token:  string
  crewId: string
  email:  string
  name:   string
}) {
  const router              = useRouter()
  const [password, setPass] = useState('')
  const [confirm, setConf]  = useState('')
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoad]  = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoad(true)
    try {
      const supabase = createClient()

      // Create Supabase Auth account
      const { data, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      })

      if (signUpErr)  throw signUpErr
      if (!data.user) throw new Error('Account creation failed — please try again')

      // Link Auth user to crew record
      const res = await fetch('/api/crew/accept-invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, userId: data.user.id }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to activate account')
      }

      router.push('/crew')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoad(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700
                        text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div>
        <label className="label">Email</label>
        <input
          type="email"
          value={email}
          disabled
          className="input bg-accent-50 text-accent-500 cursor-not-allowed"
        />
      </div>

      <div>
        <label className="label">
          Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPass(e.target.value)}
          className="input"
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
      </div>

      <div>
        <label className="label">
          Confirm Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConf(e.target.value)}
          className="input"
          placeholder="Repeat password"
          autoComplete="new-password"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-cta w-full py-2.5 disabled:opacity-60"
      >
        {loading ? 'Creating account…' : 'Activate Account →'}
      </button>
    </form>
  )
}
```

### 5e — Accept invite API route

**New file:** `app/api/crew/accept-invite/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.token || !body?.userId) {
    return NextResponse.json(
      { error: 'Missing token or userId' },
      { status: 400 }
    )
  }

  const { token, userId } = body as { token: string; userId: string }
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, user_id, invite_accepted_at')
    .eq('invite_token', token)
    .single()

  if (!crew) {
    return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
  }

  if (crew.user_id || crew.invite_accepted_at) {
    return NextResponse.json({ error: 'Invite already used' }, { status: 409 })
  }

  const { error } = await supabase
    .from('crew_members')
    .update({
      user_id:            userId,
      invite_accepted_at: new Date().toISOString(),
    })
    .eq('id', crew.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
```

---

## Final File Map — Everything Touched This Session

```
fieldstay_migration_v2.sql            REPLACE (add invite cols + milestones)
types/database.ts                     EDIT (add invite_sent_at to CrewMember)
middleware.ts                         EDIT (add /crew/accept-invite to PUBLIC_ROUTES)

app/(dashboard)/properties/[id]/setup/checklist/
  checklist-builder.tsx               EDIT (bulk photo toggles — Steps 3a/3b/3c)

app/(dashboard)/settings/
  actions.ts                          EDIT (add inviteCrewMember)
  settings-tabs.tsx                   EDIT (invite button in crew rows)
  page.tsx                            EDIT (fetch invite fields)

app/crew/
  turnovers/[id]/page.tsx             REPLACE (full photo capture — Step 4)

app/crew/accept-invite/[token]/       CREATE (new directory)
  page.tsx                            CREATE
  accept-invite-form.tsx              CREATE

app/api/crew/
  accept-invite/route.ts              CREATE
```

---

## Code Patterns

### Auth (every server component + server action)
```ts
const { user, supabase, membership } = await requireOrgMember()
// Always filter by membership.org_id — never skip
```

### Service client (Inngest, webhooks, tokenized routes ONLY)
```ts
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Bypasses RLS — never in dashboard pages or regular server actions
```

### Crew pages — PowerSync pattern
```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'

const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])
const db = usePowerSync()
await db.execute('UPDATE ... SET ... WHERE id = ?', [value, id])
```

### Pre-built CSS (use before writing custom Tailwind)
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta                          ← yellow, MUST use text-brand-800
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
.section-header  .page-title  .page-subtitle  .page-header
```

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()` (validates JWT server-side)
3. Never forget `revalidatePath()` after mutations
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`
7. `btn-cta` (yellow) MUST use `text-brand-800` — never white text on yellow

---

## Verification Checklist

After completing all steps, verify:

- [ ] v2 migration re-run — check `crew_members` table in Supabase for
  `invite_token`, `invite_sent_at`, `invite_accepted_at` columns
- [ ] Settings → Crew tab → crew member with email shows "Invite to app" button
- [ ] Click invite → email received → link goes to `/crew/accept-invite/[token]`
- [ ] Accept invite form → create account → redirected to `/crew`
- [ ] In Supabase, `crew_members.user_id` now populated for that crew member
- [ ] Checklist builder → global photo toggle switches all items
- [ ] Section header camera button toggles all items in that section
- [ ] Crew app turnover page → item with `requires_photo=true` → tapping
  circle triggers camera → photo uploads → item auto-checks off
- [ ] Item with `requires_photo=false` → tapping circle toggles immediately
  (no camera prompt)
- [ ] "Mark as Complete" on a turnover with pending photos → shows confirm
  dialog before proceeding
