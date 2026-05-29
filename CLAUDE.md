# CLAUDE.md — FieldStay: Stripe Billing Enforcement + Compliance

Read every section before writing a single line of code.
This task touches payments, subscriptions, and customer data.
Treat it with the same care you would a security audit.

---

## Context

FieldStay is a multi-tenant SaaS platform for STR property managers.
Billing is handled entirely by Stripe. The app uses **Stripe Checkout**
(hosted, redirect-based) — card data never touches FieldStay servers.
This qualifies the app for **PCI-DSS SAQ A**, the lightest compliance
tier. Your job is to enforce billing state in the app and ensure the
implementation is fully compliant with SAQ A and general security
best practices.

---

## What Needs to Be Built — 3 Changes, 4 Files

| # | What | File(s) |
|---|------|---------|
| 1 | Handle `checkout.session.completed` webhook to link new Stripe customers to their org | `app/api/webhooks/stripe/route.ts` |
| 2 | Add `trial_ends_at` to the org data available throughout the app | `lib/auth.ts`, `app/(dashboard)/layout.tsx` |
| 3 | Gate the dashboard: block `cancelled`/`paused` orgs and expired trials; warn `past_due` orgs | `app/(dashboard)/layout.tsx`, new `app/billing-wall/page.tsx` |

**Note on property limits:** The `createProperty` action in
`app/(dashboard)/properties/actions.ts` already enforces `max_properties`.
Do NOT touch that file.

---

## Change 1 — Webhook: Handle `checkout.session.completed`

**File:** `app/api/webhooks/stripe/route.ts`

### The problem

The existing webhook handles `customer.subscription.created` and
`customer.subscription.updated` by looking up the org via
`stripe_customer_id`. But for a brand new customer, `stripe_customer_id`
hasn't been set on the org yet when those events fire — so the lookup
returns null and the plan is never activated.

The `checkout.session.completed` event fires after a successful checkout
and includes `session.metadata.org_id` (set in `createCheckoutSession`
in settings/actions.ts) and `session.customer` (the new Stripe customer
ID). This is where we link the org to its Stripe customer.

### Implementation

Add this case to the `switch (event.type)` block, **before** the
`customer.subscription.created` case:

```typescript
case 'checkout.session.completed': {
  const session    = event.data.object
  const orgId      = session.metadata?.org_id
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : null

  if (!orgId || !customerId) {
    // Missing metadata — log for investigation, do not throw
    console.error(
      '[Stripe] checkout.session.completed missing org_id or customer',
      { sessionId: session.id }
    )
    break
  }

  // Only set stripe_customer_id if not already set (idempotency guard)
  await supabase
    .from('organizations')
    .update({ stripe_customer_id: customerId })
    .eq('id', orgId)
    .is('stripe_customer_id', null)

  // No inngest event needed here — customer.subscription.created
  // will fire immediately after and handle plan activation now that
  // stripe_customer_id is set.
  break
}
```

### Rules for this change

- Log ONLY `session.id` in the error case — never log the full
  `session` object or `event.data.object` (may contain billing details).
- The `.is('stripe_customer_id', null)` guard is required for idempotency.
  If Stripe retries the webhook, this prevents overwriting a valid ID.
- Do NOT add logging anywhere that outputs Stripe customer IDs,
  subscription IDs, or price IDs to stdout/console in production.
  Structured error logging (console.error with minimal context) is
  acceptable only for genuine error paths.
- Do NOT modify the webhook signature verification logic at the top
  of the handler. It must remain the first thing that runs.
- Do NOT add any `console.log` statements. Only `console.error` on
  actual error paths, with minimal identifying info (IDs only, no
  payment data).

---

## Change 2 — Add `trial_ends_at` to Auth Context

**Files:** `lib/auth.ts`, `app/(dashboard)/layout.tsx`

### In `lib/auth.ts`

Add `trial_ends_at` to the `OrgMembership` interface:

```typescript
export interface OrgMembership {
  org_id: string
  role: MemberRole
  org: {
    name:           string
    plan:           string
    plan_status:    string
    max_properties: number
    trial_ends_at:  string | null   // ADD THIS
  }
}
```

In `requireOrgMember()`, update the Supabase select to include
`trial_ends_at`:

```typescript
// Find this line:
organizations ( name, plan, plan_status, max_properties )

// Replace with:
organizations ( name, plan, plan_status, max_properties, trial_ends_at )
```

And update the membership object construction to include it:

```typescript
const membership: OrgMembership = {
  org_id: row.org_id,
  role:   row.role as MemberRole,
  org: {
    name:           orgData?.name           ?? '',
    plan:           orgData?.plan           ?? 'starter',
    plan_status:    orgData?.plan_status    ?? 'trialing',
    max_properties: orgData?.max_properties ?? 5,
    trial_ends_at:  orgData?.trial_ends_at  ?? null,  // ADD THIS
  },
}
```

### In `app/(dashboard)/layout.tsx`

The layout fetches org data independently (it doesn't call
`requireOrgMember()`). Add `trial_ends_at` to its select:

```typescript
// Find this line:
organizations(name, plan, plan_status, max_properties)

// Replace with:
organizations(name, plan, plan_status, max_properties, trial_ends_at)
```

---

## Change 3 — Dashboard Gate + Billing Wall

**Files:** `app/(dashboard)/layout.tsx`, new `app/billing-wall/page.tsx`

### Gate logic

There are four possible billing states that need distinct handling:

| `plan_status` | Condition | Action |
|---|---|---|
| `trialing` | `trial_ends_at` is in the future, or null | Full access |
| `trialing` | `trial_ends_at` is in the past | Redirect to `/billing-wall` |
| `active` | — | Full access |
| `past_due` | — | Full access + persistent warning banner |
| `cancelled` | — | Redirect to `/billing-wall` |
| `paused` | — | Redirect to `/billing-wall` |

**Why `past_due` gets full access:** Stripe is retrying payment. The
customer has a valid subscription intent and blocking them would cause
churn. The banner is the appropriate response.

**Why `cancelled` is a hard block:** Subscription is terminated.

### Implementation in `app/(dashboard)/layout.tsx`

Add the gate immediately after the org data is extracted (after
the `const org = ...` line), before the milestone query:

```typescript
// ── Billing gate ──────────────────────────────────────────────────────────
const planStatus  = org?.plan_status  ?? 'trialing'
const trialEndsAt = org?.trial_ends_at ?? null

const trialExpired = planStatus === 'trialing'
  && trialEndsAt !== null
  && new Date(trialEndsAt) < new Date()

const isBlocked = trialExpired
  || planStatus === 'cancelled'
  || planStatus === 'paused'

const isPastDue = planStatus === 'past_due'

if (isBlocked) {
  redirect('/billing-wall')
}
// ── End billing gate ──────────────────────────────────────────────────────
```

Then, in the return JSX, add a warning banner for `past_due` orgs
**inside** `<DashboardShell>`, before `{children}`:

```tsx
{isPastDue && (
  <div
    className="mx-4 mt-4 px-4 py-3 rounded-xl flex items-center justify-between gap-4 text-sm"
    style={{
      background: 'var(--accent-red-dim)',
      border:     '1px solid rgba(240,84,84,0.3)',
    }}
  >
    <span style={{ color: 'var(--accent-red)' }}>
      <strong>Payment past due.</strong> Please update your payment method
      to avoid interruption.
    </span>
    <a
      href="/settings"
      className="text-xs font-semibold underline whitespace-nowrap"
      style={{ color: 'var(--accent-red)' }}
    >
      Update billing →
    </a>
  </div>
)}
```

### New file: `app/billing-wall/page.tsx`

This page lives **outside** the `(dashboard)` route group so the
dashboard layout gate doesn't apply to it (which would cause a redirect
loop). It must still verify the user is authenticated.

```tsx
import { redirect }     from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function BillingWallPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Not logged in at all — send to login
  if (!user) redirect('/login')

  // Fetch org status so we can show the correct message
  const { data: row } = await supabase
    .from('organization_members')
    .select('org_id, organizations(name, plan_status, trial_ends_at)')
    .eq('user_id', user.id)
    .single()

  if (!row) redirect('/login')

  const org = Array.isArray(row.organizations)
    ? row.organizations[0]
    : row.organizations

  const planStatus  = org?.plan_status  ?? 'cancelled'
  const trialEndsAt = org?.trial_ends_at ?? null

  const trialExpired = planStatus === 'trialing'
    && trialEndsAt !== null
    && new Date(trialEndsAt) < new Date()

  // If account is actually fine, redirect back to dashboard
  if (!trialExpired && planStatus !== 'cancelled' && planStatus !== 'paused') {
    redirect('/ops')
  }

  const heading = trialExpired
    ? 'Your trial has ended'
    : 'Your subscription is inactive'

  const subtext = trialExpired
    ? 'Subscribe to continue managing your properties with FieldStay.'
    : 'Your account has been deactivated. Reactivate your subscription to regain access.'

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'var(--bg-base)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-8 text-center"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* FieldStay wordmark */}
        <p
          className="text-2xl font-bold tracking-tight mb-6"
          style={{ color: 'var(--text-primary)' }}
        >
          FieldStay
        </p>

        <h1
          className="text-xl font-semibold mb-2"
          style={{ color: 'var(--text-primary)' }}
        >
          {heading}
        </h1>

        <p
          className="text-sm mb-8"
          style={{ color: 'var(--text-muted)' }}
        >
          {subtext}
        </p>

        <div className="flex flex-col gap-3">
          <a
            href="/settings"
            className="btn-primary py-3 text-base text-center block rounded-xl"
            style={{ background: 'var(--accent-gold)', color: '#0a1628', fontWeight: 700 }}
          >
            {trialExpired ? 'Subscribe Now' : 'Reactivate Subscription'}
          </a>

          <a
            href={`mailto:support@fieldstay.app`}
            className="text-sm"
            style={{ color: 'var(--text-muted)' }}
          >
            Need help? Contact support
          </a>
        </div>
      </div>
    </div>
  )
}
```

---

## PCI-DSS SAQ A Compliance

FieldStay qualifies for SAQ A because Stripe Checkout is used exclusively
(redirect to Stripe's hosted payment page — card data never touches
FieldStay infrastructure). The following requirements apply and must be
maintained throughout this implementation.

### What you MUST NOT do

**1. Never log payment data.**
Stripe webhook payloads can contain customer billing details, card
last-four digits, bank account info, and subscription data. Claude Code
must never add any logging that outputs `event.data.object`,
`session.customer`, card-related fields, or full subscription objects.
The only acceptable logging is `console.error` with minimal context
(IDs only) on genuine error paths.

**2. Never store card data.**
Do not add any database columns, localStorage keys, or state variables
that hold card numbers, CVVs, expiry dates, or full PANs — even partially.
Stripe handles all card storage. FieldStay's database holds only:
`stripe_customer_id`, `stripe_subscription_id`, `plan`, `plan_status`.
These are IDs and metadata, not payment credentials.

**3. Never expose Stripe secret keys client-side.**
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only
environment variables. They must never:
- Appear in a `'use client'` component
- Be passed as props to a client component
- Be included in any API response body
- Appear in `next.config.ts` under `env` (which exposes them to the client)
Only `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (if ever used) is safe
client-side.

**4. Never bypass webhook signature verification.**
The `stripe.webhooks.constructEvent()` call at the top of the webhook
handler must remain intact and must run before any database operations.
Do not add a dev-mode bypass or a way to skip verification via a query
param or header. Do not add the raw body parsing anywhere else.

**5. Never log the raw webhook request body.**
The raw body (`await request.text()`) is needed for signature
verification. It must not be logged. Assign it to a variable and pass
it only to `constructEvent()`.

**6. Never create API routes that accept payment-related input without
authentication.**
Any route that reads or writes `stripe_customer_id`,
`stripe_subscription_id`, `plan`, or `plan_status` must use
`createServiceClient()` (service role, bypasses RLS safely for server
operations) and must validate org ownership via explicit `.eq('org_id')`
checks, not via user-supplied input alone.

### What you MUST do

- **Maintain webhook idempotency.** All webhook handlers must be safe to
  run twice. Use `.is('stripe_customer_id', null)` guards and upserts
  where appropriate. Stripe may deliver the same webhook event more than
  once.

- **Use `createServiceClient()` for all webhook DB operations.** The
  webhook route is not authenticated as a user — it's a Stripe server
  call. Service client is correct here.

- **Return HTTP 200 for unhandled event types.** The existing `default`
  case returns `{ received: true }`. Keep it. Returning a non-200 for
  unhandled events causes Stripe to retry indefinitely.

- **Keep the billing wall page minimal.** It must not make unnecessary
  Stripe API calls or expose subscription details to the page render.
  Only fetch what is needed to show the correct message.

- **Whitelist `/billing-wall` itself from future layout gates.** The
  new page is outside `(dashboard)` so no layout gate applies. Do not
  add the billing wall to the dashboard route group.

---

## General Security Requirements

These apply to all code written during this session, not just billing code.

- **Do not modify RLS policies.** Supabase RLS is the primary data
  isolation mechanism between tenants. Do not add, remove, or modify any
  RLS policy. Do not use the service client in places where a user-scoped
  client should be used.

- **Do not add new environment variables** without noting them explicitly
  in a comment. If you need a new env var, add a comment at the top of
  the file stating what it should contain and that it must be added to
  Vercel environment settings.

- **Do not store sensitive org data in client state.** `plan_status`,
  `trial_ends_at`, and `stripe_customer_id` must never be written to
  localStorage, cookies, or client-side state. They should only be read
  server-side through `requireOrgMember()` or direct Supabase queries.

- **Do not add any client-side billing checks.** The billing gate lives
  in `app/(dashboard)/layout.tsx` (a server component). Do not add a
  parallel check in a client component — client-side checks are trivially
  bypassable and are not a security control.

- **Do not add error boundaries that swallow billing errors silently.**
  If a billing check fails (DB error, etc.), let it fail loudly via the
  existing Next.js error handling. A failed billing check is better than
  a silent one.

---

## Explicit Scope Boundaries

**You may only touch these files:**
1. `app/api/webhooks/stripe/route.ts` — add `checkout.session.completed` case
2. `lib/auth.ts` — add `trial_ends_at` to interface and query
3. `app/(dashboard)/layout.tsx` — add `trial_ends_at` to query + billing gate + past_due banner
4. `app/billing-wall/page.tsx` — create this new file

**Do not touch any other file.** Specifically:

- Do NOT modify `app/(dashboard)/properties/actions.ts` —
  property limit enforcement is already implemented.
- Do NOT modify `app/(dashboard)/settings/actions.ts` —
  checkout and billing portal are already implemented.
- Do NOT modify `app/(dashboard)/settings/settings-tabs.tsx` —
  the pricing UI is already in place.
- Do NOT modify any Supabase migration files —
  the schema already has all needed columns
  (`plan`, `plan_status`, `trial_ends_at`, `stripe_customer_id`,
  `stripe_subscription_id`, `max_properties`).
- Do NOT add any new Stripe API calls beyond what is explicitly
  described above.
- Do NOT modify the `middleware.ts` file.
- Do NOT modify `components/dashboard-shell.tsx`.

If you believe a change outside this scope is necessary, stop and
explain why before proceeding.

---

## Verification Checklist

Run `npm run build` after all changes. It must pass with zero TypeScript
errors before considering this complete.

Functional checks:

- [ ] `checkout.session.completed` case exists in webhook switch statement
- [ ] The case reads `session.metadata?.org_id` and `session.customer`
- [ ] The case uses `.is('stripe_customer_id', null)` idempotency guard
- [ ] No `console.log` added anywhere in the webhook file
- [ ] No raw event/session objects logged anywhere
- [ ] `trial_ends_at` added to `OrgMembership` interface in `lib/auth.ts`
- [ ] `trial_ends_at` added to both Supabase select queries
  (in `requireOrgMember()` and in `layout.tsx`)
- [ ] Billing gate added in `layout.tsx` after org data extraction
- [ ] Gate correctly blocks `cancelled`, `paused`, and expired trials
- [ ] Gate correctly allows `active`, `trialing` (unexpired), and `past_due`
- [ ] `past_due` warning banner renders inside `DashboardShell`
- [ ] `app/billing-wall/page.tsx` created and routes correctly
- [ ] Billing wall redirects back to `/ops` if org is actually in good standing
- [ ] Billing wall is NOT inside the `(dashboard)` route group
- [ ] No Stripe secret key referenced in any client component or prop
- [ ] `npm run build` passes clean

---

## Notes

- The `(dashboard)` group layout gate will NOT cause a redirect loop
  because `billing-wall/page.tsx` is outside that route group.
  Verify the file path is `app/billing-wall/page.tsx`, not
  `app/(dashboard)/billing-wall/page.tsx`.

- Stripe's `checkout.session.completed` event fires before
  `customer.subscription.created`. Once the customer is linked via
  Change 1, the existing `customer.subscription.created` handler will
  find the org by `stripe_customer_id` and activate the plan correctly.
  No changes to `customer.subscription.created` are needed.

- The `trial_ends_at` field on `organizations` is only set when Stripe
  fires a subscription event with a `trial_end` timestamp. For orgs
  created before billing was wired up, it may be `null`. The gate
  treats `null` `trial_ends_at` on a `trialing` account as an
  active trial (no expiry enforced). This is intentional —
  existing test accounts should not be accidentally blocked.
