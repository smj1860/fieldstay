# CLAUDE.md — FieldStay Development Guide

This file tells Claude Code everything it needs to know to work on the FieldStay codebase.
Read this entire file before writing any code or running any commands.

---

## What Is FieldStay?

FieldStay is a multi-tenant SaaS platform for short-term rental (STR) property managers.
It is a standalone product — not connected to any other codebase.

**Core value:** One platform for turnover coordination, inventory tracking, maintenance
scheduling, and owner reporting. Offline-capable for cleaning crews via PowerSync.

**Tech stack:**
- **Framework:** Next.js 15 (App Router, TypeScript)
- **Database:** Supabase (Postgres + Row Level Security + Realtime + Storage)
- **Auth:** Supabase Auth
- **Background jobs:** Inngest (event-driven, scheduled functions)
- **Offline sync:** PowerSync (SQLite on-device for crew app)
- **Email:** Resend
- **Payments:** Stripe
- **Hosting:** Vercel

---

## First-Time Setup (Claude Code Environment)

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Environment variables

```bash
cp .env.example .env.local
```

Then fill in every variable in `.env.local`. The required services are:

**Supabase** — create a project at https://supabase.com
- `NEXT_PUBLIC_SUPABASE_URL` — project URL from Settings > API
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key from Settings > API
- `SUPABASE_SERVICE_ROLE_KEY` — service role key from Settings > API

**Inngest** — create an account at https://inngest.com, create an app named `fieldstay`
- `INNGEST_EVENT_KEY` — from Manage > Keys
- `INNGEST_SIGNING_KEY` — from Manage > Keys

**Resend** — create an account at https://resend.com, add domain `fieldstay.com`
- `RESEND_API_KEY` — API key
- `RESEND_FROM_EMAIL` — verified sender email (e.g. noreply@fieldstay.com)
- `RESEND_FROM_NAME` — "FieldStay"

**Stripe** — create account at https://stripe.com
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` — from Webhooks > endpoint
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` — price IDs

**PowerSync** — create account at https://powersync.com, connect Supabase project
- `NEXT_PUBLIC_POWERSYNC_URL` — instance URL

**App**
- `NEXT_PUBLIC_APP_URL` — `http://localhost:3000` for local dev

### Step 3 — Supabase database setup

Run the migration file in the Supabase SQL Editor:
1. Go to https://supabase.com/dashboard/project/[your-project]/sql
2. Paste and run the entire contents of `fieldstay_migration_v1.sql`
3. This creates all 30 tables, 57 RLS policies, 55 indexes, and seeds inventory catalog data

Then create Storage buckets (in Supabase Dashboard > Storage > New Bucket):
- `turnover-photos` — public
- `work-order-photos` — public
- `crew-uploads` — public

### Step 4 — Run the dev server

In terminal 1:
```bash
npm run dev
```

In terminal 2 (for Inngest local dev):
```bash
npm run inngest:dev
```

Inngest dev server runs at http://localhost:8288 — visit it to see and trigger functions.

### Step 5 — Verify everything works

1. Visit http://localhost:3000 — should redirect to /login
2. Sign up for an account (the signup page still needs to be built — see build queue)
3. For now, create a user in Supabase Dashboard > Authentication > Users
4. Then manually insert an organization and organization_member record in the SQL editor

---

## Repository Structure

```
fieldstay/
├── app/
│   ├── (auth)/                    # Public auth pages
│   │   ├── login/                 # ✅ Built
│   │   └── signup/                # ⬜ TODO
│   ├── (dashboard)/               # Protected PM/manager views
│   │   ├── layout.tsx             # ✅ Sidebar nav, org membership check
│   │   ├── properties/            # ✅ Full CRUD + 7-step wizard
│   │   ├── turnovers/             # ✅ Board + detail
│   │   ├── inventory/             # ⬜ TODO (stub exists)
│   │   ├── maintenance/           # ⬜ TODO (stub exists)
│   │   ├── communications/        # ⬜ TODO (stub exists)
│   │   ├── owners/                # ⬜ TODO (stub exists)
│   │   └── settings/              # ⬜ TODO (stub exists)
│   ├── crew/                      # Crew offline PWA (PowerSync)
│   │   └── layout.tsx             # ✅ Basic shell — full app TODO
│   ├── owner/[token]/             # ✅ Tokenized owner portal shell
│   └── api/
│       ├── inngest/route.ts       # ✅ All functions registered
│       ├── webhooks/stripe/       # ✅ Subscription lifecycle
│       └── work-orders/[token]/   # ✅ Vendor completion portal
├── lib/
│   ├── supabase/                  # ✅ server.ts, client.ts, middleware.ts
│   ├── inngest/
│   │   ├── client.ts              # ✅
│   │   ├── events.ts              # ✅ All event types defined
│   │   └── functions/             # ✅ All 8 functions built
│   ├── ical/parser.ts             # ✅
│   ├── turnovers/generator.ts     # ✅
│   ├── resend/client.ts           # ✅
│   ├── stripe/client.ts           # ✅
│   ├── auth.ts                    # ✅ requireAuth, requireOrgMember, requireProperty
│   ├── wizard.ts                  # ✅ WIZARD_STEPS, step helpers
│   └── utils.ts                   # ✅ cn, formatDate, formatWindow, etc.
├── types/
│   └── database.ts                # ✅ All 30 tables typed
├── middleware.ts                  # ✅ Route protection
├── fieldstay_migration_v1.sql     # ✅ Complete database schema
└── CLAUDE.md                      # This file
```

---

## Code Patterns — Read Before Writing Any Code

### Pattern 1: Server Components fetch data, Client Components handle interaction

```tsx
// page.tsx — Server Component (fetches data)
export default async function InventoryPage({ params }) {
  const { supabase, membership } = await requireOrgMember()
  const { data: items } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('org_id', membership.org_id)
  return <InventoryList items={items ?? []} />
}

// inventory-list.tsx — Client Component (handles interaction)
'use client'
export function InventoryList({ items }) {
  const [state, action, pending] = useActionState(updateItem, null)
  // ...
}
```

### Pattern 2: Server Actions with `useActionState`

```ts
// actions.ts
'use server'
export async function updateInventoryItem(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const { supabase, membership } = await requireOrgMember()
  // Always verify org ownership before mutating
  // ...
  revalidatePath('/inventory')
  return { success: true }
}
```

```tsx
// client form
'use client'
const [state, action, pending] = useActionState(updateInventoryItem, null)
return <form action={action}>...</form>
```

### Pattern 3: Auth helpers

```ts
// Simple auth check — use in every Server Component and Server Action
const { user, supabase, membership } = await requireOrgMember()
// membership.org_id, membership.role, membership.org.plan

// Property ownership check
const { property, supabase, membership } = await requireProperty(propertyId)
// If property doesn't belong to org → automatic redirect to /properties
```

### Pattern 4: Service client for background jobs

```ts
// In Inngest functions and webhook handlers — bypasses RLS
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Use for: iCal sync, email sending, Stripe webhooks
```

### Pattern 5: Inngest functions

```ts
export const myFunction = inngest.createFunction(
  { id: 'my-function', name: 'Human Readable Name', retries: 2 },
  { event: 'my-event/name' as const },
  async ({ event, step, logger }) => {
    // Use step.run() for each discrete unit of work
    // Each step is retried independently if it fails
    const result = await step.run('step-name', async () => {
      // Database operations, API calls, etc.
    })
    // Use step.sleepUntil() for time-based delays
    await step.sleepUntil('wait-label', new Date('2025-01-01'))
    // Use step.sendEvent() to fan out
    await step.sendEvent('fan-out', [{ name: 'other/event', data: {} }])
  }
)
// Register in app/api/inngest/route.ts
```

### Pattern 6: Database queries — always filter by org_id

```ts
// WRONG — missing org_id filter (RLS will catch it but be explicit)
const { data } = await supabase.from('properties').select('*')

// RIGHT — always include org_id
const { data } = await supabase
  .from('properties')
  .select('*')
  .eq('org_id', membership.org_id)
```

### Pattern 7: TypeScript types

```ts
// Import types from types/database.ts — never use `any`
import type { Property, Turnover, WorkOrder } from '@/types/database'

// For Supabase query results with joins, define inline types
interface TurnoverWithAssignment extends Turnover {
  turnover_assignments: TurnoverAssignment[]
}
```

### Pattern 8: Tailwind styling

Use only the design tokens defined in `tailwind.config.ts`:
- `brand-800` = forest green (primary buttons, sidebar)
- `accent-*` = slate scale (text, borders, backgrounds)
- Pre-built component classes in `globals.css`: `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.card`, `.input`, `.label`, `.badge`, `.badge-green`, `.badge-amber`, `.badge-red`, `.badge-blue`, `.badge-slate`, `.section-header`, `.page-title`, `.page-subtitle`

---

## What Has Been Built

### Database (complete)
- 30 tables, 57 RLS policies, 55 indexes
- Full multi-tenant isolation via `org_id` on every table
- 4 roles: admin, manager, crew, viewer
- Inventory catalog pre-seeded with 38 common STR items

### Auth & Middleware
- Supabase Auth integration (login form built)
- Route protection via `middleware.ts`
- `requireOrgMember()` and `requireProperty()` helpers in `lib/auth.ts`

### Properties (complete)
- Properties list with setup progress indicators
- Add new property form
- 7-step setup wizard (details, iCal, inventory, messages, checklist, maintenance, crew)
- Each wizard step saves independently with progress tracking

### Turnovers (complete)
- Board grouped by: urgent, today, tomorrow, this week, upcoming, completed
- Inline crew assignment dropdown
- Status updates: assigned → in_progress → completed / flagged
- Manual turnover creation modal
- Turnover detail page with checklist instance view
- Manual iCal sync trigger

### Inngest Functions (complete — all registered)
- `syncAllIcalFeeds` — cron every 4h, fans out per feed
- `syncIcalFeed` — parse iCal, upsert bookings, generate turnovers
- `handleBookingDetected` — booking confirmation email + pre-checkout reminder (sleepUntil)
- `handleTurnoverCreated` — crew notification + 24h unassigned warning
- `handleTurnoverCompleted` — PM notification
- `dailyMaintenanceCheck` — cron 8am, alert or auto-create work orders
- `handleInventoryCountSubmitted` — apply count, generate PO, email PM
- `handleWorkOrderCreated` — vendor portal link email
- `handleWorkOrderCompletedViaPortal` — PM notification
- `handleWorkOrderOverdue` — overdue alert

### Supporting Libraries
- `lib/ical/parser.ts` — robust iCal parsing (ical.js)
- `lib/turnovers/generator.ts` — turnover generation from booking pairs
- `lib/resend/client.ts` — email client + `renderTemplate()` for `{{variable}}` substitution
- `lib/stripe/client.ts` — Stripe client + plan definitions
- `lib/wizard.ts` — wizard step constants and helpers

---

## Build Queue — What Still Needs to Be Built

Build in this order — each item depends on the previous.

### 1. Signup + Onboarding (NEXT — nothing works without this)

**Files to create:**
- `app/(auth)/signup/page.tsx`
- `app/(auth)/signup/signup-form.tsx` (client)
- `app/onboarding/page.tsx` — create org + first property
- `app/onboarding/layout.tsx`

**Key implementation notes:**
- Signup form: email + password + full name → `supabase.auth.signUp()`
- After signup, redirect to `/onboarding`
- Onboarding creates the `organizations` record and the first `organization_members` row
- Organization `slug` = `slugify(orgName)` — must be unique; add suffix if collision
- After org created, redirect to `/properties/new`
- The `handle_new_user` trigger in Supabase auto-creates the `profiles` row

**Organization creation (server action):**
```ts
// Create org
const { data: org } = await supabase.from('organizations').insert({
  name, slug, billing_email: user.email, plan: 'starter', plan_status: 'trialing',
  trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
}).select('id').single()

// Add user as admin
await supabase.from('organization_members').insert({
  org_id: org.id, user_id: user.id, role: 'admin',
  invite_accepted_at: new Date().toISOString(),
})
```

---

### 2. Inventory Management Page

**Files to create:**
- `app/(dashboard)/inventory/page.tsx` (replace stub — server)
- `app/(dashboard)/inventory/inventory-manager.tsx` (client)
- `app/(dashboard)/inventory/actions.ts`

**What it shows:**
- Tabs per property (or property filter dropdown)
- All inventory items grouped by category with current qty vs par level
- Color coding: red = at/below par, amber = low, green = healthy
- Edit par level inline
- Add custom item
- View purchase order history
- "Run inventory count" button → shows a form for PM to manually enter quantities

**Inventory count from dashboard (PM can do it, not just crew):**
```ts
// Server action: submitInventoryCount
// Creates inventory_count + inventory_count_items records
// Fires inngest event: 'inventory/count-submitted'
await inngest.send({ name: 'inventory/count-submitted', data: { count_id, property_id, org_id } })
```

---

### 3. Maintenance Page (Work Orders)

**Files to create:**
- `app/(dashboard)/maintenance/page.tsx` (replace stub — server)
- `app/(dashboard)/maintenance/maintenance-board.tsx` (client)
- `app/(dashboard)/maintenance/[id]/page.tsx` — work order detail
- `app/(dashboard)/maintenance/actions.ts`

**What it shows:**
- Work orders grouped by status: pending, assigned, in_progress, completed
- Filter by property, vendor, priority
- Create work order modal (title, property, vendor, scheduled_date, priority, description, estimated_cost, portal_enabled toggle)
- Work order detail: status history (work_order_updates), photos, completion notes

**Create work order server action:**
```ts
// After insert, if portal_enabled, fire Inngest event
if (portal_enabled) {
  await inngest.send({ name: 'work-order/created', data: {
    work_order_id: wo.id, property_id, org_id,
    vendor_id: vendor_id ?? null, portal_enabled: true,
  }})
}
```

**Vendor portal page (tokenized, no auth):**
- `app/work-orders/[token]/page.tsx` — form to mark complete + upload photos
- Calls `POST /api/work-orders/[token]/complete` (already built)

---

### 4. Settings Page

**Files to create:**
- `app/(dashboard)/settings/page.tsx` (replace stub)
- `app/(dashboard)/settings/org-settings.tsx`
- `app/(dashboard)/settings/crew-management.tsx`
- `app/(dashboard)/settings/vendor-management.tsx`
- `app/(dashboard)/settings/billing.tsx`
- `app/(dashboard)/settings/actions.ts`

**Sections (tab-based):**
1. **Organization** — name, billing email
2. **Crew** — list all crew members, add new, edit contact + notification prefs, deactivate
3. **Vendors** — list vendors, add new, edit specialty + portal_enabled toggle
4. **Billing** — current plan, Stripe billing portal link, upgrade options
5. **Danger Zone** — account settings

**Stripe billing portal:**
```ts
// Server action
const session = await stripe.billingPortal.sessions.create({
  customer: org.stripe_customer_id,
  return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
})
redirect(session.url)
```

---

### 5. Communications Page (Sent Message Log)

**Files to create:**
- `app/(dashboard)/communications/page.tsx` (replace stub)

**What it shows:**
- Table of all `guest_messages_sent` for the org
- Columns: date sent, property, guest, trigger (booking/checkout), subject, status
- Filter by property, trigger type, date range
- Simple read-only view — no editing needed

---

### 6. Owner Portal (P&L View)

**Files to create:**
- `app/(dashboard)/owners/page.tsx` (replace stub — manage owners, generate portal links)
- `app/(dashboard)/owners/actions.ts`
- `app/owner/[token]/page.tsx` (replace stub — the actual owner portal view)

**PM-side (dashboard):**
- List all `property_owners` across the org
- Add owner: name, email, property, revenue_share_pct
- Generate portal link → creates `owner_portal_tokens` record, emails owner

**Owner portal (/owner/[token]):**
- Full P&L view for their property
- Revenue table (booking_revenue transactions)
- Expense table (maintenance, restock, other)
- Net calculation per month
- Work order history
- Simple and clean — not an accounting tool

**P&L data model:**
```ts
// owner_transactions table has: transaction_type (revenue|expense), category, amount, description, date
// Revenue is added manually or auto-created from booking data
// Expenses are auto-created when work orders and POs are completed
```

**Add manual transaction server action:**
```ts
await supabase.from('owner_transactions').insert({
  property_id, org_id, transaction_type, category,
  amount, description, transaction_date,
  work_order_id: null, purchase_order_id: null,
})
```

---

### 7. Crew App (PowerSync Offline)

This is the most complex remaining feature. Build after all dashboard features are stable.

**Files to create:**
- `app/crew/page.tsx` (replace stub — crew dashboard)
- `app/crew/turnovers/page.tsx` — list of assigned turnovers
- `app/crew/turnovers/[id]/page.tsx` — turnover + checklist (offline)
- `app/crew/inventory/[propertyId]/page.tsx` — inventory count form (offline)
- `lib/powersync/schema.ts` — PowerSync client schema
- `lib/powersync/client.ts` — PowerSync client setup
- `components/crew/PowerSyncProvider.tsx` — context provider

**PowerSync setup:**
```ts
// lib/powersync/schema.ts
import { Column, ColumnType, Index, IndexedColumn, Schema, Table } from '@powersync/web'

const turnovers = new Table({
  property_id:       new Column({ type: ColumnType.TEXT }),
  checkout_datetime: new Column({ type: ColumnType.TEXT }),
  checkin_datetime:  new Column({ type: ColumnType.TEXT }),
  status:            new Column({ type: ColumnType.TEXT }),
  // ... other fields
}, { indexes: [] })

export const AppSchema = new Schema([turnovers, /* checklist_instances, etc. */])
```

**Sync rules (configure in PowerSync dashboard):**
```yaml
# Sync rules in PowerSync app — syncs only what crew needs
- table: turnovers
  parameters:
    - sql: SELECT ta.turnover_id FROM turnover_assignments ta
             JOIN crew_members cm ON ta.crew_member_id = cm.id
             WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]

- table: checklist_instance_items
  parameters:
    - sql: SELECT cii.id FROM checklist_instance_items cii
             JOIN checklist_instances ci ON cii.instance_id = ci.id
             JOIN turnovers t ON ci.turnover_id = t.id
             JOIN turnover_assignments ta ON ta.turnover_id = t.id
             JOIN crew_members cm ON ta.crew_member_id = cm.id
             WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]
```

**Key implementation:** Crew app uses `usePowerSyncQuery()` hooks instead of Supabase queries. Writes go through PowerSync's offline queue and sync when online.

---

### 8. Billing (Stripe Checkout)

**Files to create:**
- `app/(dashboard)/billing/page.tsx`
- `app/api/billing/checkout/route.ts` — create Stripe checkout session
- `app/api/billing/portal/route.ts` — create Stripe billing portal session

**Stripe checkout:**
```ts
const session = await stripe.checkout.sessions.create({
  customer: org.stripe_customer_id ?? undefined,
  customer_email: org.stripe_customer_id ? undefined : user.email,
  mode: 'subscription',
  payment_method_types: ['card'],
  line_items: [{ price: PLANS[selectedPlan].priceId, quantity: 1 }],
  success_url: `${APP_URL}/settings?upgraded=true`,
  cancel_url: `${APP_URL}/settings`,
  metadata: { org_id: org.id },
})
```

The Stripe webhook (`app/api/webhooks/stripe/route.ts`) is already built and handles subscription lifecycle.

---

## Important Rules

### Never do these things:

1. **Never skip the `org_id` filter** on any database query. Even with RLS, always be explicit.

2. **Never use the service client in client components or server components.** Service client is only for Inngest functions and webhook handlers.

3. **Never put secrets in client-side code.** Variables without `NEXT_PUBLIC_` prefix are server-only.

4. **Never call `supabase.auth.getSession()` — use `supabase.auth.getUser()`.** `getSession()` reads from cookie without server validation. `getUser()` makes a network call that validates the JWT.

5. **Never forget `revalidatePath()`** after mutations. Without it, the page won't show updated data.

6. **Never create a new Inngest function without registering it** in `app/api/inngest/route.ts`.

7. **Never use `any` type.** Import from `types/database.ts` instead.

### Always do these things:

1. **Always use `requireOrgMember()`** at the top of every Server Component page and Server Action.

2. **Always use the `cn()` utility** for conditional class names.

3. **Always bump `LMD_ADMIN_VERSION` (n/a for FieldStay)** — for FieldStay, just ensure `revalidatePath()` is called after mutations.

4. **Always handle the loading/pending state** in forms (`disabled={pending}`).

5. **Always use pre-built CSS classes** from `globals.css` (`.btn-primary`, `.card`, `.input`, etc.) before writing custom Tailwind.

6. **Always protect the `org_id`** in joins — if a query involves multiple tables, verify org ownership at the root table level.

---

## Database Quick Reference

### Key tables and their primary relationships:

```
organizations (tenant root)
  └── organization_members → auth.users (role: admin|manager|crew|viewer)
  └── properties → org_id
        └── ical_feeds → property_id
        └── bookings → ical_feed_id, property_id
        └── turnovers → booking_id, prev_booking_id, property_id
              └── turnover_assignments → crew_member_id
              └── checklist_instances → turnover_id
                    └── checklist_instance_items
        └── inventory_items → property_id
              └── inventory_counts (from crew)
        └── purchase_orders → property_id
        └── work_orders → vendor_id, property_id
        └── maintenance_schedules → property_id
        └── guest_message_templates → property_id
  └── crew_members → org_id (may have user_id for app login)
  └── vendors → org_id
  └── checklist_templates → org_id, property_id (null = org-level)
```

### Canonical table names (easy to get wrong):
- Properties: `lmd_property_profiles` — NO. For FieldStay it's just `properties`
- There is no `lmd_` prefix — this is a clean Supabase schema
- Crew: `crew_members` (not `lmd_crew_members`)

### RLS helper functions (defined in migration):
- `get_user_org_ids()` — returns org_ids for current user
- `is_org_member(org_id, roles[])` — check membership + role
- `get_crew_member_id()` — get crew_members.id for current user

---

## Email Templates

All guest emails use `{{variable}}` syntax. The `renderTemplate()` function in
`lib/resend/client.ts` substitutes them at send time.

Available variables: `guest_name`, `property_name`, `property_address`,
`checkin_date`, `checkout_date`, `checkin_time`, `checkout_time`,
`wifi_name`, `wifi_password`, `door_code`, `host_name`, `host_phone`

Emails are HTML but written with simple inline styles — no email framework needed.
Keep them readable as plain text (use `<br/>` not complex layouts).

---

## Stripe Plan Configuration

Plans are defined in `lib/stripe/client.ts`:

| Plan       | Properties | Price ID env var          |
|------------|-----------|---------------------------|
| starter    | 5         | `STRIPE_PRICE_STARTER`    |
| growth     | 20        | `STRIPE_PRICE_GROWTH`     |
| pro        | 50        | `STRIPE_PRICE_PRO`        |
| enterprise | unlimited | (custom — contact sales)  |

The `organizations.max_properties` field is set by the Stripe webhook handler
when a subscription is created/updated.

---

## Deployment Checklist

Before deploying to Vercel:

1. ✅ All env vars set in Vercel project settings
2. ✅ Supabase migration run on production database
3. ✅ Supabase Storage buckets created: `turnover-photos`, `work-order-photos`, `crew-uploads`
4. ✅ Inngest app configured with production event key + signing key
5. ✅ Stripe webhook endpoint pointing to `https://app.fieldstay.com/api/webhooks/stripe`
6. ✅ Resend domain verified
7. ✅ PowerSync instance connected to production Supabase

---

## Running Tests / Debugging

### Test the iCal sync locally:
1. Start both `npm run dev` and `npm run inngest:dev`
2. Visit http://localhost:8288 (Inngest dev UI)
3. In the Functions tab, find "Sync All iCal Feeds"
4. Click "Invoke" to trigger a manual sync
5. Watch the event stream for any errors

### Test email sending locally:
Resend has a test mode — emails go to a sandbox inbox.
For local dev, set `RESEND_API_KEY=re_test_...` (test key) to avoid sending real emails.

### Check RLS is working:
In Supabase SQL Editor, run queries as a specific user:
```sql
SET request.jwt.claims = '{"sub": "user-uuid-here"}';
SELECT * FROM properties; -- should only return that user's org's properties
```
