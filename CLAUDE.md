# CLAUDE.md — FieldStay

Read this entire file before writing any code or running any commands.

---

## Current State

The codebase is feature-complete. All Phase 1 and Phase 2 features are
built and committed. The Vercel build is failing for one reason:
`RESEND_API_KEY` and several other environment variables are not set in
Vercel, causing SDK clients to crash during module initialization at
build time.

**Two tasks remain:**
1. Code: make SDK clients crash-safe when env vars are missing (Step 1)
2. Operations: add all missing env vars to Vercel (Step 2)

After both are done, the build will pass and the app will be live.

---

## Step 1 — Safe SDK Initialization (Code Changes)

### Why this is happening

Next.js evaluates imported modules at build time. When
`lib/resend/client.ts` runs `new Resend(undefined!)` because
`RESEND_API_KEY` is not set in Vercel, the process crashes and the
build fails. The fix: use `?? ''` so the SDK receives an empty string
instead of `undefined` — SDKs initialize without throwing on an empty
string, and will only fail with a clear error message when they
actually attempt an API call at runtime.

### Fix lib/resend/client.ts

Change line 7:

```ts
// Before:
export const resend = new Resend(process.env.RESEND_API_KEY!)

// After:
export const resend = new Resend(process.env.RESEND_API_KEY ?? '')
```

No other changes needed in this file.

### Fix lib/stripe/client.ts

`STRIPE_SECRET_KEY` is already set in Vercel so this isn't currently
crashing, but apply the same pattern for safety:

```ts
// Before:
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {

// After:
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
```

No other changes needed in this file.

That's the only code change required. After committing these two lines,
move to Step 2.

---

## Step 2 — Add All Environment Variables to Vercel

### How to add them

Vercel Dashboard → your FieldStay project → **Settings** →
**Environment Variables** → Add each variable below for the
**Production** environment.

### Variables to add (Stephen has STRIPE_SECRET_KEY — add everything else)

---

#### SUPABASE

**Where to find:** Supabase Dashboard → your project →
Settings → API

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your project URL — looks like `https://abcdefgh.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The `anon` / `public` key (long JWT string) |
| `SUPABASE_SERVICE_ROLE_KEY` | The `service_role` key — **treat as a secret, never expose client-side** |

---

#### INNGEST

**Where to find:** https://app.inngest.com → your FieldStay app →
Manage → Keys

| Variable | Value |
|----------|-------|
| `INNGEST_EVENT_KEY` | Event key — starts with `evt_` |
| `INNGEST_SIGNING_KEY` | Signing key — starts with `signkey-prod-` |

---

#### RESEND

**Where to find:** https://resend.com → API Keys → Create API Key
(give it full access, name it "FieldStay Production")

| Variable | Value |
|----------|-------|
| `RESEND_API_KEY` | API key — starts with `re_` |
| `RESEND_FROM_EMAIL` | `noreply@fieldstay.app` (type this literally) |
| `RESEND_FROM_NAME` | `FieldStay` (type this literally) |

> **Note:** Resend will reject emails until `fieldstay.app` is verified
> as a sending domain. Go to Resend → Domains → Add Domain →
> `fieldstay.app` → add the DNS records at Namecheap → wait for
> verification. Until then, emails send from Resend's shared domain
> which may land in spam.

---

#### STRIPE

**Already set:** `STRIPE_SECRET_KEY` ✅

**Where to find the rest:**
- API keys: Stripe Dashboard → Developers → API keys
- Webhook secret: Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret
- Price IDs: Stripe Dashboard → Products → click each product → copy the Price ID

| Variable | Where |
|----------|-------|
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → endpoint → Signing secret (starts with `whsec_`) |
| `STRIPE_PRICE_PRO_MONTHLY` | The `price_` ID for Pro, $149/month |
| `STRIPE_PRICE_PRO_ANNUAL` | The `price_` ID for Pro, $1,490/year |
| `STRIPE_PRICE_GROWTH_MONTHLY` | The `price_` ID for Growth, $219/month |
| `STRIPE_PRICE_GROWTH_ANNUAL` | The `price_` ID for Growth, $2,190/year |

> **Stripe webhook setup (if not done yet):**
> Stripe Dashboard → Developers → Webhooks → Add endpoint
> URL: `https://app.fieldstay.app/api/webhooks/stripe`
> Events to select:
> - `customer.subscription.created`
> - `customer.subscription.updated`
> - `customer.subscription.deleted`
> Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

---

#### POWERSYNC

**Where to find:** https://app.powersync.com → your project →
Instances → click your instance → copy the Instance URL

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_POWERSYNC_URL` | Your instance URL — looks like `https://abc123.powersync.journey.tech` |

> **Note:** PowerSync sync rules also need to be configured in the
> dashboard (see External Configuration section below). This is a
> separate step from the env var.

---

#### APP URL

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_APP_URL` | `https://app.fieldstay.app` (type this literally) |

---

### Complete variable checklist

| # | Variable | Status |
|---|----------|--------|
| 1 | `NEXT_PUBLIC_SUPABASE_URL` | ⬜ Add |
| 2 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ⬜ Add |
| 3 | `SUPABASE_SERVICE_ROLE_KEY` | ⬜ Add |
| 4 | `INNGEST_EVENT_KEY` | ⬜ Add |
| 5 | `INNGEST_SIGNING_KEY` | ⬜ Add |
| 6 | `RESEND_API_KEY` | ⬜ Add |
| 7 | `RESEND_FROM_EMAIL` | ⬜ Add |
| 8 | `RESEND_FROM_NAME` | ⬜ Add |
| 9 | `STRIPE_SECRET_KEY` | ✅ Done |
| 10 | `STRIPE_WEBHOOK_SECRET` | ⬜ Add |
| 11 | `STRIPE_PRICE_PRO_MONTHLY` | ⬜ Add |
| 12 | `STRIPE_PRICE_PRO_ANNUAL` | ⬜ Add |
| 13 | `STRIPE_PRICE_GROWTH_MONTHLY` | ⬜ Add |
| 14 | `STRIPE_PRICE_GROWTH_ANNUAL` | ⬜ Add |
| 15 | `NEXT_PUBLIC_POWERSYNC_URL` | ⬜ Add |
| 16 | `NEXT_PUBLIC_APP_URL` | ⬜ Add |

After adding all 16, trigger a new Vercel deployment (push a commit or
click **Redeploy** in the Vercel dashboard). The build should pass.

---

## Step 3 — Domain Setup in Vercel

Once the build passes, add custom domains in Vercel:

Vercel Dashboard → your project → Settings → Domains

Add these two:
1. `fieldstay.app` — the marketing landing page at `/`
2. `app.fieldstay.app` — the main app

For each domain, Vercel will show you DNS records to add. Go to
Namecheap → your domain → Advanced DNS → add each record Vercel
shows:

- For `fieldstay.app`: add an **A record** pointing to Vercel's IP,
  or a **CNAME** if Vercel offers that option for apex domains
- For `app.fieldstay.app`: add a **CNAME record** →
  `cname.vercel-dns.com`

SSL is automatic — Vercel provisions it for free via Let's Encrypt.
Do NOT buy SSL from Namecheap.

---

## Step 4 — Post-Deploy: Register Inngest Functions

After the first successful deploy, Inngest needs to discover the
functions. Visit this URL once (it auto-registers them):

```
https://app.fieldstay.app/api/inngest
```

Then go to https://app.inngest.com → your app → Functions — all 10
functions should appear:
- syncAllIcalFeeds
- syncIcalFeed
- handleBookingDetected
- handleTurnoverCreated
- handleTurnoverCompleted
- dailyMaintenanceCheck
- handleInventoryCountSubmitted
- handleWorkOrderCreated
- handleWorkOrderCompletedViaPortal
- handleWorkOrderOverdue

If they don't appear, check that `INNGEST_EVENT_KEY` and
`INNGEST_SIGNING_KEY` are set correctly in Vercel.

---

## External Configuration — PowerSync Sync Rules

**Not a code change — configure in the PowerSync dashboard.**

1. Go to https://app.powersync.com → your project → **Sync Rules**
2. Replace all content with the YAML below and click **Deploy**

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

## Full Launch Checklist

### Code
- [ ] `lib/resend/client.ts` — `?? ''` safe init applied
- [ ] `lib/stripe/client.ts` — `?? ''` safe init applied
- [ ] Both committed and pushed

### Vercel
- [ ] All 16 env vars added (checklist above)
- [ ] Build passes — green checkmark in Vercel dashboard
- [ ] `fieldstay.app` domain added and verified
- [ ] `app.fieldstay.app` domain added and verified
- [ ] SSL active on both domains (Vercel handles automatically)

### Supabase
- [ ] v1 migration confirmed run on production project
- [ ] v2 migration confirmed run on production project
- [ ] Storage buckets created: `turnover-photos`, `work-order-photos`,
  `crew-uploads` (Supabase Dashboard → Storage → New Bucket, set to
  Public)

### Inngest
- [ ] Functions registered — visit `https://app.fieldstay.app/api/inngest`
- [ ] All 10 functions visible in Inngest dashboard

### Stripe
- [ ] Webhook endpoint created pointing to
  `https://app.fieldstay.app/api/webhooks/stripe`
- [ ] All 4 price IDs in Vercel env vars
- [ ] Test: create a Stripe test checkout and confirm subscription
  webhook fires correctly

### Resend
- [ ] `fieldstay.app` domain verified in Resend
- [ ] Test: trigger an iCal sync with a property that has a booking
  → confirm booking confirmation email arrives

### PowerSync
- [ ] Sync rules deployed in PowerSync dashboard
- [ ] Test: crew member logs into `/crew` on a phone → assignments
  visible → turn off Wi-Fi → still visible

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

### Crew (PowerSync offline reads + writes)
```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])
const db = usePowerSync()
await db.execute('UPDATE ... SET ... WHERE id = ?', [value, id])
```

### CSS
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta     ← gold (#FCD116) — MUST use text-brand-800, never white
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
```

### Brand tokens
```
bg-brand-800    = #102246  primary navy
bg-gold-300     = #FCD116  action yellow (dark text only)
bg-accent-50    = #F8F9FA  page backgrounds
text-accent-800 = #1A1D20  body text
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
