# CLAUDE.md — FieldStay

Read this entire file before writing any code or running any commands.

---

## Current State — Feature Complete

**The codebase is done.** Every planned feature has been built and pushed.

| Area | Status |
|------|--------|
| Auth — signup, login, onboarding | ✅ |
| Properties CRUD + 7-step setup wizard | ✅ |
| Turnovers board + detail + crew assignment | ✅ |
| Checklist instances + bulk photo toggles | ✅ |
| Inventory — catalog picker, par levels, PO generation | ✅ |
| Maintenance — work orders, schedules, vendor portal | ✅ |
| Communications — guest message log | ✅ |
| Owners — transaction P&L, portal link generation | ✅ |
| Settings — org, crew, vendors, Stripe billing | ✅ |
| Owner portal — tokenized P&L | ✅ |
| Vendor portal — tokenized WO completion | ✅ |
| Crew app — PowerSync offline, checklists, photo capture | ✅ |
| Crew invite flow — email invite + accept-invite pages | ✅ |
| Inngest pipeline — 10 functions, all registered | ✅ |
| Review / Milestone framework | ✅ |
| Public landing page | ✅ |
| Brand colors (#102246 navy, #FCD116 gold) | ✅ |
| Migrations v1 + v2 | ✅ |

---

## What Remains Before Launch

There are no remaining code features. What's left is:

1. **Two small placeholder values** in the code that need real values
2. **Four external service configurations** (not code changes)
3. **Vercel production deployment**

---

## Code: Two Placeholder Values to Update

### 1 — Pricing on the landing page

**File:** `app/page.tsx`

The three pricing cards show `$XX` for the monthly price. Update with
the actual prices once decided.

```tsx
// Find these three occurrences and replace $XX:
{ name: 'Starter', price: '$XX', props: 'Up to 5 properties', ... }
{ name: 'Growth',  price: '$XX', props: 'Up to 20 properties', ... }
{ name: 'Pro',     price: '$XX', props: 'Up to 50 properties', ... }
```

Also update the contact email in the footer if `hello@fieldstay.com`
is not yet active:
```tsx
<a href="mailto:hello@fieldstay.com" ...>Contact</a>
```

### 2 — Google review URL in the review prompt

**File:** `components/review-prompt.tsx`

The review CTA opens a placeholder Google review link:

```ts
const REVIEW_URL = 'https://g.page/r/FIELDSTAY_GOOGLE_PLACE_ID/review'
```

Replace `FIELDSTAY_GOOGLE_PLACE_ID` with the actual ID once the
Google Business Profile for FieldStay is created and verified.

To get the ID:
1. Set up a Google Business Profile at business.google.com
2. Once verified, go to the profile → Get more reviews → copy the short URL
3. The ID is the string after `g.page/r/` in that URL

Until then, optionally change the URL to a Capterra or G2 listing,
or point it to `mailto:feedback@fieldstay.com` as a temporary stand-in.

---

## External Configuration — PowerSync Sync Rules

**Not a code change.** Configure in the PowerSync dashboard.

### Steps

1. Go to https://powersync.com → log in → open your FieldStay instance
2. Left sidebar → **Sync Rules**
3. Replace all content in the YAML editor with the rules below
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
The `SupabaseConnector` in `lib/powersync/client.ts` handles passing
this automatically when crew log in on their devices.

**Verify it's working:**
- PowerSync dashboard → **Diagnostics** → look for a connected client
- On a crew device: log in at `/crew` → assignments should appear
- Turn off Wi-Fi → assignments and checklists still visible (offline)
- Check off a task → syncs to Supabase when connection returns

---

## External Configuration — Stripe

**Not a code change.** Configure in the Stripe dashboard.

### 1 — Create products and prices

1. Go to https://dashboard.stripe.com → **Products** → **Add product**
2. Create three products with monthly recurring prices:

| Product | Properties | Suggested price | Env var |
|---------|-----------|-----------------|---------|
| FieldStay Starter | Up to 5 | — | `STRIPE_PRICE_STARTER` |
| FieldStay Growth  | Up to 20 | — | `STRIPE_PRICE_GROWTH` |
| FieldStay Pro     | Up to 50 | — | `STRIPE_PRICE_PRO` |

3. Copy each price ID (starts with `price_`) into your environment variables

### 2 — Create webhook endpoint

1. Stripe dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. Endpoint URL: `https://app.fieldstay.com/api/webhooks/stripe`
3. Select events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** (starts with `whsec_`) → `STRIPE_WEBHOOK_SECRET`

### 3 — Test the webhook locally before deploying

```bash
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Prints a signing secret — use that for local STRIPE_WEBHOOK_SECRET
```

---

## External Configuration — Resend Domain

**Not a code change.**

1. Go to https://resend.com → **Domains** → **Add Domain**
2. Enter `fieldstay.com`
3. Add the TXT and MX DNS records shown to your domain registrar
4. Wait for verification (usually under 30 minutes)
5. Update `RESEND_FROM_EMAIL` in your Vercel environment variables:
   ```
   RESEND_FROM_EMAIL = noreply@fieldstay.com
   ```

Until the domain is verified, Resend's pre-verified address works for
testing: `onboarding@resend.dev` (already in `.env.example`).

---

## Deployment — Vercel

### 1 — Import project

1. Go to https://vercel.com → **Add New Project**
2. Import from GitHub → select the `fieldstay` repo
3. Framework: Next.js (auto-detected)
4. Click **Deploy** — first deploy will fail on build until env vars are set

### 2 — Set environment variables

In the Vercel project → **Settings** → **Environment Variables**,
add all of the following for the **Production** environment:

```
NEXT_PUBLIC_SUPABASE_URL          = https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     = your-anon-key
SUPABASE_SERVICE_ROLE_KEY         = your-service-role-key

INNGEST_EVENT_KEY                 = from Inngest → Manage → Keys
INNGEST_SIGNING_KEY               = from Inngest → Manage → Keys

RESEND_API_KEY                    = from Resend → API Keys
RESEND_FROM_EMAIL                 = noreply@fieldstay.com
RESEND_FROM_NAME                  = FieldStay

NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_live_...
STRIPE_SECRET_KEY                  = sk_live_...
STRIPE_WEBHOOK_SECRET              = whsec_...
STRIPE_PRICE_STARTER               = price_...
STRIPE_PRICE_GROWTH                = price_...
STRIPE_PRICE_PRO                   = price_...

NEXT_PUBLIC_POWERSYNC_URL         = https://your-instance.powersync.journey.tech

NEXT_PUBLIC_APP_URL               = https://app.fieldstay.com
```

### 3 — Custom domains

In Vercel project → **Settings** → **Domains**:
- Add `app.fieldstay.com` → points to the Next.js app (dashboard + API)
- Add `fieldstay.com` + `www.fieldstay.com` → also points to this project
  (the landing page at `/` handles marketing traffic)

### 4 — Run v2 migration on production

The Supabase project already has v1 running. If v2 hasn't been run
on production yet:
1. Go to Supabase Dashboard → **SQL Editor**
2. Paste and run `fieldstay_migration_v2.sql`
3. All statements use `IF NOT EXISTS` — safe to run even if partially done

### 5 — Redeploy

After setting all env vars, trigger a new deployment in Vercel.
All builds should pass.

---

## Launch Checklist

Work through this top to bottom before announcing to users.

### Code
- [ ] `app/page.tsx` — `$XX` pricing replaced with real prices
- [ ] `components/review-prompt.tsx` — `FIELDSTAY_GOOGLE_PLACE_ID`
      replaced with real ID (or temporary fallback URL)
- [ ] `hello@fieldstay.com` email address is active and monitored

### Supabase
- [ ] v1 migration confirmed run on production project
- [ ] v2 migration confirmed run on production project
- [ ] Storage buckets exist: `turnover-photos`, `work-order-photos`, `crew-uploads`
- [ ] Confirm RLS is **enabled** on all tables (check in Table Editor → each table → RLS badge)

### PowerSync
- [ ] Sync rules deployed (YAML above) — status shows green in dashboard
- [ ] Test: crew member logs in on a phone, sees assigned turnovers offline

### Stripe
- [ ] Three products + prices created, price IDs in Vercel env vars
- [ ] Webhook endpoint created, pointing to `https://app.fieldstay.com/api/webhooks/stripe`
- [ ] Webhook test: trigger a `customer.subscription.created` event in Stripe
      → check Vercel function logs for success

### Resend
- [ ] `fieldstay.com` domain verified
- [ ] Test email: add a property with a guest booking and trigger a manual
      iCal sync → confirm booking confirmation email arrives

### Inngest
- [ ] Inngest app in production mode (not dev)
- [ ] Visit `https://app.fieldstay.com/api/inngest` to register all functions
- [ ] Inngest dashboard → Functions → confirm all 10 functions appear
- [ ] Trigger a manual "Sync All iCal Feeds" from the Inngest dashboard
      to confirm pipeline works end to end

### Vercel / App
- [ ] `app.fieldstay.com` loads dashboard (login required)
- [ ] `fieldstay.com` loads landing page (no login required)
- [ ] Signup → onboarding → add property → connect iCal → full flow works
- [ ] Invite a crew member → accept invite → log in to `/crew`

---

## Code Patterns (Reference)

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

### Crew pages — PowerSync (offline-capable reads + writes)
```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])
const db = usePowerSync()
await db.execute('UPDATE ... SET ... WHERE id = ?', [value, id])
```

### Pre-built CSS
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta       ← gold (#FCD116) — MUST use text-brand-800, never white text
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

## Inngest Pipeline (10 Functions — All Registered)

```
cron (4h)   → iCal sync → bookings + turnovers + checklist instances
                         + booking revenue transactions
                         + first_ical_sync milestone
cron (8am)  → maintenance check → alerts or auto WOs
                                 + thirty_days milestone check
booking     → confirmation email → sleepUntil → pre-checkout email
turnover    → crew notification → sleepUntil 24h → unassigned warning
            → on complete → PM notification
                          + first/10th/50th completion milestones
inventory   → apply quantities → below par → PO + PM email
                               + first_purchase_order milestone
work order  → vendor portal link → on complete → PM alert + expense transaction
```
