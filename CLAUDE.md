# CLAUDE.md — FieldStay

Complete reference for working on this codebase. Read every section before
writing any code or running any commands.

---

## 🚨 Fix This First — Critical Bug

**`middleware.ts` is missing from the repo root.**

The file `middleware (35).ts` at root is junk (wrong content, wrong name).
Without `middleware.ts`, Next.js cannot protect any routes. Fix before anything else.

**Step 1 — Delete all junk root files:**

```bash
rm -f "actions (16).ts" "actions (19).ts" "actions (21).ts" "actions (23).ts" \
      "actions (27).ts" "actions (30).ts" actions.ts auth.ts \
      booking-events.ts "client (37).ts" "client (38).ts" client.ts \
      details-form.tsx events.ts fieldstay-complete.zip ical-form.tsx \
      inventory-events.ts "layout (33).tsx" "layout (34).tsx" "layout (4).tsx" \
      layout.tsx maintenance-check.ts maintenance-form.tsx messages-form.tsx \
      "middleware (35).ts" "page (12).tsx" "page (15).tsx" "page (17).tsx" \
      "page (18).tsx" "page (31).tsx" "page (8).tsx" page.tsx parser.ts \
      server.ts turnover-events.ts utils.ts wizard.ts
```

**Step 2 — Recreate `middleware.ts` at repo root:**

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const PUBLIC_ROUTES = ['/login', '/signup', '/forgot-password', '/reset-password']
const TOKEN_ROUTES  = ['/owner/', '/work-orders/', '/api/work-orders']
const BYPASS_ROUTES = ['/api/inngest', '/api/webhooks/stripe', '/_next', '/favicon', '/robots', '/sitemap']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (BYPASS_ROUTES.some((r) => pathname.startsWith(r))) return NextResponse.next()
  if (TOKEN_ROUTES.some((r) => pathname.startsWith(r)))  return NextResponse.next()

  const { supabaseResponse, user } = await updateSession(request)

  const isPublic = PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/properties'
    url.search   = ''
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
```

Commit and push this fix before doing anything else.

---

## What Is FieldStay?

Multi-tenant SaaS for short-term rental (STR) property managers.
Standalone product — not connected to any other codebase.

**Core features:** turnover coordination, inventory with purchase orders,
maintenance scheduling, guest messaging, and owner P&L reporting.
Offline-capable for cleaning crews via PowerSync.

**Stack:**
| Layer        | Tech                              |
|--------------|-----------------------------------|
| Framework    | Next.js 15 (App Router, TS)       |
| Database     | Supabase (Postgres + RLS)         |
| Auth         | Supabase Auth                     |
| Storage      | Supabase Storage                  |
| Background   | Inngest                           |
| Offline sync | PowerSync (crew app — not built)  |
| Email        | Resend                            |
| Payments     | Stripe                            |
| Hosting      | Vercel                            |

---

## First-Time Local Setup

### 1 — Install dependencies
```bash
npm install
```

### 2 — Environment variables
```bash
cp .env.example .env.local
```

Fill `.env.local`:

**Supabase** — project → Settings → API
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

**Inngest** — app named `fieldstay` → Manage → Keys
```
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

**Resend**
```
RESEND_API_KEY=
RESEND_FROM_EMAIL=onboarding@resend.dev   # pre-verified for local dev
RESEND_FROM_NAME=FieldStay
```

**Stripe**
```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_GROWTH=
STRIPE_PRICE_PRO=
```
Local webhook testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`

**PowerSync** — placeholder until crew app is built
```
NEXT_PUBLIC_POWERSYNC_URL=https://placeholder.powersync.journey.tech
```

**App**
```
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3 — Run the migration

In Supabase SQL Editor: run `fieldstay_migration_v1.sql` in full.
Then run the v2 migration from **Outstanding Schema Changes** below.

Create Storage buckets (public): `turnover-photos`, `work-order-photos`, `crew-uploads`

### 4 — Dev servers

```bash
npm run dev          # Terminal 1
npm run inngest:dev  # Terminal 2 — UI at http://localhost:8288
```

### 5 — First user

Sign up at http://localhost:3000/signup → onboarding → add first property.

---

## Outstanding Schema Changes (Run After v1 Migration)

```sql
-- v2: avg_nightly_rate on properties (booking revenue auto-calculation)
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- v2: booking_id on owner_transactions (link revenue to specific booking)
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id ON owner_transactions(booking_id);
```

Also update `types/database.ts`:
```ts
// In Property interface, add:
avg_nightly_rate: number | null

// In OwnerTransaction interface, add:
booking_id: string | null
```

---

## Repository Structure

```
fieldstay/
├── middleware.ts                    ← RECREATE (see top of file)
├── fieldstay_migration_v1.sql       ✅ Run in Supabase SQL Editor
├── package.json / next.config.ts / tailwind.config.ts / tsconfig.json / vercel.json
│
├── types/database.ts                ✅ All 30 tables typed — update for v2
│
├── lib/
│   ├── auth.ts                      ✅ requireAuth, requireOrgMember, requireProperty
│   ├── utils.ts                     ✅ cn, formatDate, formatWindow, status maps
│   ├── wizard.ts                    ✅ WIZARD_STEPS helpers
│   ├── ical/parser.ts               ✅ iCal parsing
│   ├── turnovers/generator.ts       ✅ NEEDS checklist instance creation (Fix 1)
│   ├── supabase/{server,client,middleware}.ts  ✅
│   ├── inngest/
│   │   ├── client.ts + events.ts    ✅
│   │   └── functions/
│   │       ├── ical-sync.ts         ✅
│   │       ├── booking-events.ts    ✅ NEEDS booking revenue auto-create (Fix 2b)
│   │       ├── turnover-events.ts   ✅
│   │       ├── maintenance-check.ts ✅
│   │       ├── inventory-events.ts  ✅
│   │       └── work-order-events.ts ✅ NEEDS expense auto-create (Fix 2c)
│   ├── resend/client.ts             ✅
│   └── stripe/client.ts             ✅
│
├── app/
│   ├── (auth)/login/ + signup/      ✅
│   ├── onboarding/                  ✅
│   ├── (dashboard)/
│   │   ├── layout.tsx + dashboard-nav.tsx  ✅
│   │   ├── properties/              ✅ Full CRUD + 7-step wizard
│   │   │   └── [id]/setup/          ✅ NEEDS avg_nightly_rate in details step (Fix 2a)
│   │   ├── turnovers/               ✅ Board + detail
│   │   ├── inventory/               ✅ NEEDS catalog picker in add modal (Fix 3)
│   │   ├── maintenance/             ✅ Work order board + schedule management + WO detail
│   │   ├── communications/          ✅ Sent message log
│   │   ├── owners/                  ✅ NEEDS transaction management UI (Fix 2d)
│   │   └── settings/                ✅ Org / Crew / Vendors / Billing
│   ├── owner/[token]/page.tsx       ✅ Read-only P&L portal
│   ├── work-orders/[token]/         ✅ Vendor completion portal
│   ├── crew/                        ⬜ STUB — build after fixes
│   └── api/inngest/ + webhooks/stripe/ + work-orders/[token]/complete/  ✅
```

---

## Three Things to Fix (In Order)

---

### Fix 1 — Checklist instances never created

When a turnover is generated, no `checklist_instance` or `checklist_instance_items`
records are created. The crew sees empty turnovers even when the property has
a checklist set up.

**Edit:** `lib/turnovers/generator.ts`

After the `supabase.from('turnovers').insert(...)` that creates a turnover and
confirms the id, add immediately after:

```ts
// Snapshot the default checklist into an instance for this turnover
if (defaultTemplate?.id && turnover) {
  const { data: sections } = await supabase
    .from('checklist_template_sections')
    .select(`
      id, name, sort_order,
      checklist_template_items ( id, task, requires_photo, notes, sort_order )
    `)
    .eq('template_id', defaultTemplate.id)
    .order('sort_order', { ascending: true })

  if (sections && sections.length > 0) {
    const { data: instance } = await supabase
      .from('checklist_instances')
      .insert({
        turnover_id:       turnover.id,
        org_id:            orgId,
        template_id:       defaultTemplate.id,
        template_snapshot: sections,
        status:            'not_started',
      })
      .select('id')
      .single()

    if (instance) {
      const items = sections.flatMap((section) =>
        (section.checklist_template_items ?? []).map((item: {
          task: string; requires_photo: boolean; notes: string | null; sort_order: number
        }) => ({
          instance_id:    instance.id,
          section_name:   section.name,
          task:           item.task,
          requires_photo: item.requires_photo,
          notes:          item.notes,
          sort_order:     item.sort_order,
          is_completed:   false,
        }))
      )
      if (items.length > 0) {
        await supabase.from('checklist_instance_items').insert(items)
      }
    }
  }
}
```

---

### Fix 2 — Owner P&L: auto-populate revenue/expenses + manual entry UI

The owner portal always shows $0 because `owner_transactions` is never populated.

**Design:** Three data sources feed the P&L:
1. **Booking revenue** — auto-created when iCal detects a new booking,
   calculated as `nights × property.avg_nightly_rate` (if the PM has set a rate)
2. **Work order expenses** — auto-created when PM or vendor marks a WO complete
   and there is a cost on it
3. **Manual entries** — PM can add any revenue or expense from the owners dashboard
   (nightly rate overrides, cleaning fees, utilities, insurance, anything)

The owner portal is read-only — data flows in from the dashboard, not from the portal.

#### Fix 2a — Add avg_nightly_rate to property details step

**Edit:** `app/(dashboard)/properties/[id]/setup/details/details-form.tsx`

Add after the check-in/check-out time grid:

```tsx
<div>
  <label htmlFor="avg_nightly_rate" className="label">
    Average Nightly Rate ($)
  </label>
  <input
    id="avg_nightly_rate"
    name="avg_nightly_rate"
    type="number"
    min="0"
    step="0.01"
    defaultValue={property.avg_nightly_rate ?? ''}
    className="input"
    placeholder="e.g. 285.00"
  />
  <p className="text-xs text-accent-400 mt-1">
    Used to automatically estimate booking revenue in the owner portal.
    You can always adjust individual entries manually.
  </p>
</div>
```

**Edit:** `app/(dashboard)/properties/[id]/setup/details/actions.ts`

Parse and include in the update:

```ts
const avg_nightly_rate = formData.get('avg_nightly_rate')
  ? parseFloat(formData.get('avg_nightly_rate') as string)
  : null
// Add avg_nightly_rate to the supabase.update(...) payload
```

Apply the same field to `app/(dashboard)/properties/new/new-property-form.tsx`.

#### Fix 2b — Auto-create booking revenue transaction in Inngest

**Edit:** `lib/inngest/functions/booking-events.ts`

In `handleBookingDetected`, add a new step after fetching the booking/property data:

```ts
await step.run('create-booking-revenue-transaction', async () => {
  const supabase = createServiceClient()

  // Fetch nightly rate from the property
  const { data: prop } = await supabase
    .from('properties')
    .select('avg_nightly_rate')
    .eq('id', property_id)
    .single()

  // Skip if PM hasn't set a rate — they'll add manually
  if (!prop?.avg_nightly_rate) return

  // Avoid duplicate if already recorded (re-sync scenario)
  const { count } = await supabase
    .from('owner_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('booking_id', booking_id)

  if ((count ?? 0) > 0) return

  // Calculate nights
  const checkin  = new Date(booking.checkin_date + 'T00:00:00')
  const checkout = new Date(booking.checkout_date + 'T00:00:00')
  const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
  if (nights <= 0) return

  const amount      = parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
  const guestLabel  = booking.guest_name ? ` — ${booking.guest_name}` : ''
  const description = `${nights} night${nights !== 1 ? 's' : ''}${guestLabel}`

  await supabase.from('owner_transactions').insert({
    property_id,
    org_id,
    booking_id,
    transaction_type: 'revenue',
    category:         'booking_revenue',
    amount,
    description,
    transaction_date: booking.checkin_date,
    notes:            `${booking.source} · ${booking.checkin_date} to ${booking.checkout_date}`,
  })
})
```

#### Fix 2c — Auto-create expense when work order is completed

**Edit:** `app/(dashboard)/maintenance/actions.ts`

In `updateWorkOrderStatus`, after marking the WO complete, add:

```ts
if (status === 'completed') {
  // Fetch the WO to get cost
  const { data: wo } = await supabase
    .from('work_orders')
    .select('actual_cost, estimated_cost, title, property_id')
    .eq('id', workOrderId)
    .single()

  const cost = wo?.actual_cost ?? wo?.estimated_cost
  if (wo && cost && cost > 0) {
    // Check not already recorded
    const { count } = await supabase
      .from('owner_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('work_order_id', workOrderId)

    if ((count ?? 0) === 0) {
      await supabase.from('owner_transactions').insert({
        property_id:      wo.property_id,
        org_id:           membership.org_id,
        work_order_id:    workOrderId,
        transaction_type: 'expense',
        category:         'maintenance',
        amount:           cost,
        description:      wo.title,
        transaction_date: new Date().toISOString().split('T')[0],
      })
    }
  }
}
```

Apply the same pattern in `lib/inngest/functions/work-order-events.ts` inside
`handleWorkOrderCompletedViaPortal` — if `actual_cost` is on the WO, create
the expense transaction there too.

#### Fix 2d — Manual transaction UI in Owners dashboard

Add server actions to `app/(dashboard)/owners/actions.ts`:

```ts
export async function addOwnerTransaction(
  _prev: OwnersActionState | null,
  formData: FormData
): Promise<OwnersActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id      = formData.get('property_id') as string
  const transaction_type = formData.get('transaction_type') as 'revenue' | 'expense'
  const category         = formData.get('category') as string
  const amount           = parseFloat(formData.get('amount') as string)
  const description      = (formData.get('description') as string)?.trim()
  const transaction_date = formData.get('transaction_date') as string
  const notes            = (formData.get('notes') as string)?.trim() || null

  if (!property_id)           return { error: 'Property is required' }
  if (!description)           return { error: 'Description is required' }
  if (!amount || amount <= 0) return { error: 'Amount must be greater than 0' }
  if (!transaction_date)      return { error: 'Date is required' }

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const { error } = await supabase.from('owner_transactions').insert({
    property_id,
    org_id:           membership.org_id,
    transaction_type,
    category:         category as import('@/types/database').TxnCategory,
    amount,
    description,
    transaction_date,
    notes,
  })

  if (error) return { error: error.message }

  revalidatePath('/owners')
  return { success: true }
}

export async function deleteOwnerTransaction(txnId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('owner_transactions')
    .delete()
    .eq('id', txnId)
    .eq('org_id', membership.org_id)
  revalidatePath('/owners')
}
```

**Edit:** `app/(dashboard)/owners/page.tsx`

Add transaction fetch:

```ts
const { data: transactions } = await supabase
  .from('owner_transactions')
  .select('id, property_id, transaction_type, category, amount, description, transaction_date, notes, work_order_id, booking_id')
  .eq('org_id', membership.org_id)
  .order('transaction_date', { ascending: false })
```

Pass `transactions` to `OwnersManager`.

**Edit:** `app/(dashboard)/owners/owners-manager.tsx`

Add a collapsible "Transactions" panel per owner that shows:
- All existing transactions for that property (grouped by month, newest first)
- Each row: date | type badge | category | description | amount | delete button
- "Add Transaction" button that opens an inline form

The add transaction form collects:
- **Type:** Revenue / Expense (toggle — two buttons, not a dropdown)
- **Date:** date input (defaults to today)
- **Category:** select (booking_revenue, cleaning_fee, maintenance, restock, utility, insurance, supplies, other)
- **Description:** text (required) — e.g. "4-night stay", "HVAC repair", "Internet bill"
- **Amount:** number (required, always positive — type determines +/−)
- **Notes:** optional text

The category list for **Revenue**: booking_revenue, other
The category list for **Expense**: cleaning_fee, maintenance, restock, utility, insurance, supplies, other

Keep the form simple — no linking to bookings or work orders required. Auto-populated
transactions from Inngest already handle that linkage.

---

### Fix 3 — Add catalog picker to inventory add-item modal

The `/inventory` page add-item modal only allows custom items. PMs who want
to add a standard item (toilet paper, dish soap, etc.) after initial setup
must type everything manually.

#### Fix 3a — Pass catalog items from server

**Edit:** `app/(dashboard)/inventory/page.tsx`

Add to the `Promise.all`:

```ts
supabase
  .from('inventory_catalog')
  .select('id, name, category, default_unit')
  .eq('is_active', true)
  .order('category')
  .order('name'),
```

Pass `catalogItems` to `InventoryManager`.

#### Fix 3b — Update InventoryManager props

Add `catalogItems: CatalogItem[]` to the Props interface and component signature.
Define:

```ts
interface CatalogItem {
  id: string
  name: string
  category: InventoryCategory
  default_unit: string
}
```

Compute which catalog items are already added to the selected property:

```ts
const existingCatalogIds = new Set(
  propertyItems.map((i) => i.catalog_item_id).filter(Boolean) as string[]
)
```

Pass both to `AddItemModal`.

#### Fix 3c — Replace AddItemModal with two-tab version

Make `AddItemModal` have two tabs: **From Catalog** and **Custom Item**.

**From Catalog tab:**
- Category filter pills at the top (All, Paper Goods, Cleaning, Kitchen, Bath, etc.)
- Scrollable list of available catalog items (exclude already-added ones, show a "Already added" note for those)
- Clicking a row selects it (highlighted state)
- Par level input appears once an item is selected
- Submit button shows the selected item name: `Add "Toilet Paper"`

**Custom Item tab:**
- Existing form unchanged (name, category, unit, par level, notes)

Both tabs submit to the same `addInventoryItem` action.

#### Fix 3d — Update addInventoryItem action

**Edit:** `app/(dashboard)/inventory/actions.ts`

Accept `catalog_item_id`:

```ts
const catalog_item_id = (formData.get('catalog_item_id') as string) || null

// In the insert, change catalog_item_id from null to:
catalog_item_id,
```

---

## Next Major Feature: Crew App (PowerSync Offline)

The crew-facing app at `/crew` is a stub. Build this after the three fixes above
are working and verified.

### Files to create

```
lib/powersync/schema.ts       ← PowerSync SQLite table definitions
lib/powersync/client.ts       ← PowerSync database + Supabase connector

app/crew/page.tsx             ← Replace stub: today's assigned turnovers
app/crew/turnovers/[id]/page.tsx        ← Turnover detail
app/crew/turnovers/[id]/checklist.tsx   ← Offline checklist completion
app/crew/inventory/[propertyId]/page.tsx ← Offline inventory count form
```

### PowerSync schema

```ts
// lib/powersync/schema.ts
import { Column, ColumnType, Schema, Table } from '@powersync/web'

const turnovers = new Table({
  property_id:          new Column({ type: ColumnType.TEXT }),
  checkout_datetime:    new Column({ type: ColumnType.TEXT }),
  checkin_datetime:     new Column({ type: ColumnType.TEXT }),
  window_minutes:       new Column({ type: ColumnType.INTEGER }),
  status:               new Column({ type: ColumnType.TEXT }),
  priority:             new Column({ type: ColumnType.TEXT }),
  notes:                new Column({ type: ColumnType.TEXT }),
})

const checklist_instances = new Table({
  turnover_id: new Column({ type: ColumnType.TEXT }),
  status:      new Column({ type: ColumnType.TEXT }),
})

const checklist_instance_items = new Table({
  instance_id:        new Column({ type: ColumnType.TEXT }),
  section_name:       new Column({ type: ColumnType.TEXT }),
  task:               new Column({ type: ColumnType.TEXT }),
  is_completed:       new Column({ type: ColumnType.INTEGER }),
  requires_photo:     new Column({ type: ColumnType.INTEGER }),
  photo_storage_path: new Column({ type: ColumnType.TEXT }),
  crew_notes:         new Column({ type: ColumnType.TEXT }),
  sort_order:         new Column({ type: ColumnType.INTEGER }),
})

const inventory_items = new Table({
  property_id:      new Column({ type: ColumnType.TEXT }),
  name:             new Column({ type: ColumnType.TEXT }),
  category:         new Column({ type: ColumnType.TEXT }),
  unit:             new Column({ type: ColumnType.TEXT }),
  par_level:        new Column({ type: ColumnType.INTEGER }),
  current_quantity: new Column({ type: ColumnType.INTEGER }),
})

export const AppSchema = new Schema([
  turnovers, checklist_instances, checklist_instance_items, inventory_items,
])
```

### PowerSync client + Supabase connector

```ts
// lib/powersync/client.ts
import { PowerSyncDatabase } from '@powersync/web'
import { createClient } from '@/lib/supabase/client'
import { AppSchema } from './schema'

class SupabaseConnector {
  private supabase = createClient()

  async fetchCredentials() {
    const { data: { session } } = await this.supabase.auth.getSession()
    if (!session) throw new Error('No session')
    return {
      endpoint: process.env.NEXT_PUBLIC_POWERSYNC_URL!,
      token:    session.access_token,
    }
  }

  async uploadData(database: PowerSyncDatabase) {
    const transaction = await database.getNextCrudTransaction()
    if (!transaction) return

    for (const op of transaction.crud) {
      if (op.table === 'checklist_instance_items' && op.op === 'PUT') {
        await this.supabase
          .from('checklist_instance_items')
          .update({ is_completed: op.opData?.is_completed, crew_notes: op.opData?.crew_notes })
          .eq('id', op.id)
      }
      if (op.table === 'turnovers' && op.op === 'PUT') {
        await this.supabase
          .from('turnovers')
          .update({ status: op.opData?.status })
          .eq('id', op.id)
      }
    }
    await transaction.complete()
  }
}

let db: PowerSyncDatabase | null = null

export function getPowerSyncDb(): PowerSyncDatabase {
  if (!db) {
    db = new PowerSyncDatabase({
      schema:   AppSchema,
      database: { dbFilename: 'fieldstay-crew.db' },
    })
    db.connect(new SupabaseConnector())
  }
  return db
}
```

### Update crew layout

```tsx
// app/crew/layout.tsx
// Add PowerSyncContext.Provider wrapping children
// Import getPowerSyncDb and PowerSyncContext from @powersync/react
// Wrap the layout content in <PowerSyncContext.Provider value={getPowerSyncDb()}>
```

### Crew pages pattern

```tsx
// All crew pages use usePowerSyncQuery instead of supabase:
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'

// Read data (offline-capable):
const { data: turnovers } = usePowerSyncQuery(
  `SELECT * FROM turnovers WHERE status != 'completed' ORDER BY checkout_datetime`,
  []
)

// Write data (queued offline, syncs when online):
const db = usePowerSync()
await db.execute(
  `UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?`,
  [1, itemId]
)
```

### PowerSync sync rules (configure in PowerSync dashboard)

```yaml
- table: turnovers
  parameters:
    - sql: |
        SELECT ta.turnover_id as id FROM turnover_assignments ta
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]

- table: checklist_instances
  parameters:
    - sql: |
        SELECT ci.id FROM checklist_instances ci
        JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]

- table: checklist_instance_items
  parameters:
    - sql: |
        SELECT cii.id FROM checklist_instance_items cii
        JOIN checklist_instances ci ON cii.instance_id = ci.id
        JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]

- table: inventory_items
  parameters:
    - sql: |
        SELECT DISTINCT ii.id FROM inventory_items ii
        JOIN turnovers t ON t.property_id = ii.property_id
        JOIN turnover_assignments ta ON ta.turnover_id = t.id
        JOIN crew_members cm ON ta.crew_member_id = cm.id
        WHERE cm.user_id = token_parameters.user_id
      parameters: [user_id]
```

---

## Code Patterns

### Auth (every server component + server action)

```ts
const { user, supabase, membership } = await requireOrgMember()
// membership.org_id — always filter by this
// membership.role   — 'admin' | 'manager' | 'crew' | 'viewer'

const { property, supabase, membership } = await requireProperty(propertyId)
// redirects if property doesn't belong to org
```

### Server action

```ts
'use server'
export async function myAction(_prev: State | null, formData: FormData): Promise<State> {
  const { supabase, membership } = await requireOrgMember()
  const { error } = await supabase
    .from('table')
    .update({ field: value })
    .eq('id', id)
    .eq('org_id', membership.org_id)   // NEVER skip this
  if (error) return { error: error.message }
  revalidatePath('/page')
  return { success: true }
}
```

### Service client (Inngest + webhooks + tokenized routes only)

```ts
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Bypasses RLS — never in dashboard pages or server actions
```

### Pre-built CSS classes (use before writing custom Tailwind)

```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
.section-header  .page-title  .page-subtitle  .page-header
```

Brand: `brand-800` (forest green primary), `accent-*` (slate UI chrome).

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()` (validates JWT server-side)
3. Never forget `revalidatePath()` after any mutation
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`
7. Never expose secret env vars to client components (no `NEXT_PUBLIC_` prefix = server only)

---

## Database Reference

```
organizations (tenant root)
  └── organization_members → auth.users
  └── properties (+ avg_nightly_rate after v2)
        ├── ical_feeds → bookings → turnovers
        │     └── turnover_assignments → crew_members
        │     └── checklist_instances → checklist_instance_items
        ├── inventory_items → inventory_counts → inventory_count_items
        ├── purchase_orders → purchase_order_items
        ├── work_orders → work_order_updates, work_order_photos
        ├── maintenance_schedules
        ├── guest_message_templates
        ├── property_owners → owner_portal_tokens
        └── owner_transactions (+ booking_id after v2)
  ├── crew_members  ├── vendors  └── checklist_templates
```

---

## Inngest Event Pipeline

```
cron (every 4h) → ical/sync.all.requested
  → ical/sync.requested (per feed)
    → upsert bookings → cancel affected turnovers
    → generate turnovers + snapshot checklist instances (Fix 1)
    → booking/detected (per new booking)
        → send confirmation email
        → create revenue transaction at (nights × avg_nightly_rate) (Fix 2b)
        → sleepUntil N days pre-checkout → send reminder email
    → turnover/created
        → notify crew → sleepUntil 24h → warn PM if unassigned

cron (8am daily) → maintenance/daily-check
  → due schedules → auto WO or alert PM

inventory/count-submitted → apply count → if below par → PO + email PM

work-order/created → vendor portal link (if portal_enabled)
work-order/completed-via-portal → notify PM → create expense transaction (Fix 2c)
work-order/overdue → alert PM
```

---

## Stripe Plans

| Plan       | Max Properties | Env Var                  |
|------------|---------------|--------------------------|
| starter    | 5             | `STRIPE_PRICE_STARTER`   |
| growth     | 20            | `STRIPE_PRICE_GROWTH`    |
| pro        | 50            | `STRIPE_PRICE_PRO`       |
| enterprise | unlimited     | custom — contact sales   |

`organizations.max_properties` updated by Stripe webhook on subscription change.

---

## Deployment Checklist

- [ ] `middleware.ts` recreated at repo root, junk files deleted
- [ ] v2 migration run (ALTER TABLE statements above)
- [ ] All env vars set in Vercel project settings
- [ ] Storage buckets created: `turnover-photos`, `work-order-photos`, `crew-uploads`
- [ ] Inngest production keys configured
- [ ] Stripe webhook endpoint: `https://app.fieldstay.com/api/webhooks/stripe`
  Events: `customer.subscription.created/updated/deleted`
- [ ] Resend domain `fieldstay.com` verified

---

## Testing End-to-End Locally

1. Add a property, set `avg_nightly_rate` to 200, add inventory items with par levels, build a checklist
2. Add an owner for that property, generate a portal link
3. Trigger iCal sync in Inngest UI (http://localhost:8288)
4. Verify: bookings appear, turnovers created, checklist instances created, revenue transaction created
5. Assign crew to a turnover, open the turnover detail — checklist should be visible
6. Go to /inventory — items shown, "Run Count" fires Inngest, PO generated if below par
7. Create a work order at /maintenance, mark it complete with a cost
8. Open /owners — transaction for the work order expense should appear
9. Open the owner portal link — monthly P&L should show revenue + expense with net
