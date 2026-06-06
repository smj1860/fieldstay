# FieldStay — Integrations & Operations Reference
# Read alongside CLAUDE.md. Together they are complete.

---

## Environment Variables — Full List

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server/Inngest only — never client

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Resend
RESEND_API_KEY=
RESEND_FROM_EMAIL=                  # e.g. "FieldStay <noreply@fieldstay.app>"

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Kroger
KROGER_CLIENT_ID=
KROGER_CLIENT_SECRET=

# Mapbox (geocoding — properties and vendors)
MAPBOX_PUBLIC_TOKEN=

# Uplisting
# No OAuth — simple API key per PM, stored in organizations.uplisting_api_key
# Webhook secret for signature verification (if Uplisting supports it)
UPLISTING_WEBHOOK_SECRET=           # verify Uplisting provides this

# OwnerRez (OAuth)
OWNERREZ_CLIENT_ID=
OWNERREZ_CLIENT_SECRET=

# App
NEXT_PUBLIC_APP_URL=                # https://app.fieldstay.app
```

---

## Inngest

### Registering New Functions
Every new Inngest function must be added to the serve handler:

```typescript
// app/api/inngest/route.ts
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { buildShoppingCart }    from '@/inngest/functions/build-shopping-cart'
import { autoAssignCrew }       from '@/inngest/functions/auto-assign-crew'
import { turnoverCompleted }    from '@/inngest/functions/turnover-completed'
// ... import every function here

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    buildShoppingCart,
    autoAssignCrew,
    turnoverCompleted,
    // add every new function to this array
  ],
})
```

### Sending Events from Server Actions
```typescript
import { inngest } from '@/lib/inngest/client'

// Fire and forget — Server Action does not wait for Inngest to complete
await inngest.send({
  name: 'turnover/completed',
  data: {
    org_id:      membership.org_id,
    turnover_id: turnover.id,
    property_id: turnover.property_id,
  },
})
```

### Surfacing Inngest Results to the UI via PowerSync
Inngest steps write results to `org_milestones` (key-value store).
PowerSync syncs `org_milestones` to the client. The UI reads from local SQLite.
This is how async Inngest jobs show real-time progress without polling.

```typescript
// Inside an Inngest step — write progress/result for UI
await supabase.from('org_milestones').upsert({
  org_id,
  key:   'cart_build_status',         // unique key per job type
  value: {
    status:     'processing',
    started_at: new Date().toISOString(),
  },
}, { onConflict: 'org_id,key' })

// On completion:
await supabase.from('org_milestones').upsert({
  org_id,
  key:   'cart_build_status',
  value: {
    status:       'complete',
    matched:      14,
    cart_url:     'https://www.kroger.com/cart',
    completed_at: new Date().toISOString(),
  },
}, { onConflict: 'org_id,key' })
```

```typescript
// Client component reads from local SQLite via PowerSync
const db = usePowerSync()
const [milestone] = db.getAll(
  `SELECT value FROM org_milestones WHERE org_id = ? AND key = ?`,
  [orgId, 'cart_build_status']
)
const status = milestone ? JSON.parse(milestone.value) : null
```

### Idempotency Pattern for owner_transactions
```typescript
// Before creating any auto-populated transaction, check idempotency
const { data: existing } = await supabase
  .from('owner_transactions')
  .select('id')
  .eq('source_reference_id', sourceRecordId)
  .eq('source', sourceType)
  .single()

if (existing) {
  console.log(`[idempotent] Transaction already exists for ${sourceType}:${sourceRecordId}`)
  return { skipped: true }
}

// Safe to insert
await supabase.from('owner_transactions').insert({ ... })
```

---

## Resend / React Email

### File Locations
```
lib/resend/
  client.ts           — Resend client instance
  emails/
    shopping-cart-ready.tsx     — Cart built notification (written, needs commit)
    turnover-assigned.tsx       — Crew assignment notification
    wo-aging-alert.tsx          — WO open too long
    compliance-expiring.tsx     — COI expiry warning
    asset-health-alert.tsx      — Asset score crossed threshold
    capex-forecast-ready.tsx    — Monthly CapEx report
```

### Sending Pattern (always from Inngest steps, never from Server Actions directly)
```typescript
import { Resend } from 'resend'
import { ShoppingCartReadyEmail } from '@/lib/resend/emails/shopping-cart-ready'

const resend = new Resend(process.env.RESEND_API_KEY)

await resend.emails.send({
  from:    process.env.RESEND_FROM_EMAIL!,
  to:      recipientEmail,
  subject: '🛒 Your Kroger cart is ready',
  react:   ShoppingCartReadyEmail({ cartResult, locationName }),
})
```

### Getting PM Email in Inngest Steps
```typescript
const { data: profile } = await supabase
  .from('profiles')
  .select('full_name, email')    // check actual profiles columns — may be auth.users join
  .eq('id', userId)
  .single()
```

---

## PowerSync

### Adding a New Table to Sync
Two places must be updated every time a new table is added to PowerSync:

**1. Supabase: add to the publication**
```sql
-- Run this migration when adding a new table to client sync
ALTER PUBLICATION powersync ADD TABLE my_new_table;
```

**2. Client: update the PowerSync schema**
```typescript
// lib/powersync/schema.ts
import { Column, ColumnType, Table, Schema } from '@powersync/web'

const myNewTable = new Table({
  org_id:     new Column({ type: ColumnType.TEXT }),
  name:       new Column({ type: ColumnType.TEXT }),
  created_at: new Column({ type: ColumnType.TEXT }),
  // mirror every column the client needs to read
})

export const AppSchema = new Schema({
  // ... existing tables
  my_new_table: myNewTable,
})
```

### What Is Currently Published (Do Not Remove Without Checking)
Tables currently in the PowerSync publication include at minimum:
`properties`, `turnovers`, `turnover_assignments`, `inventory_items`,
`work_orders`, `crew_members`, `maintenance_schedules`, `communication_logs`,
`org_milestones`, `organization_members`, `organizations`, `profiles`,
`checklist_instances`, `checklist_instance_items`, `purchase_orders`,
`purchase_order_items`, `vendors`

Check `SELECT * FROM pg_publication_tables WHERE pubname = 'powersync'`
to see the actual current list before modifying.

### What Must NEVER Be Synced to Client
These tables contain sensitive or server-only data — never add to PowerSync:
- `profiles` columns with PII beyond display name
- `organizations.kroger_customer_token` / `kroger_refresh_token`
- `organizations.uplisting_api_key`
- `organizations.stripe_*`
- `integration_connections` (OAuth tokens)
- `owner_portal_tokens`
- `audit_events`
- `oauth_states`
- `asset_depreciation_entries` (sensitive financial data)
- Any table with `service_role` only data

---

## Uplisting Integration

### What Uplisting Is
A channel manager / PMS that syncs STR properties to Airbnb, VRBO, Booking.com,
and handles direct bookings. Some FieldStay PMs use Uplisting instead of OwnerRez.

### Authentication
Simple API key — **not OAuth**. The PM generates their key at
`Uplisting App → Connect → API`. FieldStay stores it in `organizations.uplisting_api_key`.

```typescript
// lib/uplisting/client.ts pattern
const UPLISTING_BASE = 'https://api.uplisting.io/v1'

async function uplistingRequest(apiKey: string, path: string) {
  const res = await fetch(`${UPLISTING_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
  })
  if (!res.ok) throw new Error(`Uplisting API ${res.status}: ${path}`)
  return res.json()
}
```

### Critical Limitation: No Total Price in API Response
**The Uplisting API does not return a total booking price.**
Revenue for owner_transactions must be calculated from nightly rates:

```typescript
// Step 1: Get booking details (check_in, check_out, property_id)
const booking = await uplistingRequest(apiKey, `/bookings/${bookingId}`)

// Step 2: Get nightly rates for the stay dates from the Calendar endpoint
const calendar = await uplistingRequest(apiKey,
  `/calendar?property_id=${booking.property_id}&start=${booking.check_in}&end=${booking.check_out}`
)

// Step 3: Sum nightly rates
const totalRevenue = calendar.dates.reduce((sum: number, d: { price: number }) =>
  sum + d.price, 0
)
```

### Rate Limits
- 5 requests/second per IP
- 100 requests/minute per IP
- 15 requests/minute per property
- Use `step.sleep('rate-limit-pause', '200ms')` between sequential property calls in Inngest

### Webhooks — Primary Real-Time Mechanism
Uplisting fires webhooks for booking events. Polling is insufficient.

```
Webhook endpoint: POST /api/webhooks/uplisting
```

```typescript
// app/api/webhooks/uplisting/route.ts
export async function POST(req: NextRequest) {
  const body = await req.json()

  // Verify webhook authenticity if Uplisting provides a secret
  // (confirm with Uplisting docs — not all PMS providers sign webhooks)

  const { event, data } = body

  switch (event) {
    case 'booking.created':
    case 'booking.modified':
      await inngest.send({ name: 'booking/confirmed', data: {
        source:     'uplisting',
        booking_id: data.id,
        // include whatever Uplisting sends
      }})
      break
    case 'booking.cancelled':
      await inngest.send({ name: 'booking/cancelled', data: { ... } })
      break
  }

  return NextResponse.json({ received: true })
}
```

### PM Setup Flow (Settings Page)
1. PM enters their Uplisting API key in FieldStay settings
2. FieldStay saves to `organizations.uplisting_api_key`
3. FieldStay makes a test call (`GET /properties`) to validate
4. PM configures their Uplisting webhook URL to point to FieldStay
5. From that point, bookings auto-populate revenue in owner portal

---

## Kroger Integration

### Files Already Written (need commit)
```
lib/kroger/types.ts         — TypeScript types for all Kroger responses
lib/kroger/client.ts        — Token management, product search, cart, location
inngest/functions/
  build-shopping-cart.ts    — Main cart automation function
app/api/kroger/
  connect/route.ts          — OAuth initiation
  callback/route.ts         — OAuth callback + token storage
```

### Auth Flow Summary
- **Client credentials** → for product search and location lookup (no user needed)
- **Customer OAuth** → for adding to cart (`cart.basic:write` scope)
- PM connects their personal Kroger account once via `/api/kroger/connect`
- Customer token stored in `organizations.kroger_customer_token`
- Token refresh handled in the cart Inngest function before each cart build

### Kroger Developer Portal Scopes Required
When setting up the Kroger application:
- `product.compact` — product search
- `cart.basic:write` — add items to customer cart
- `profile.compact` — verify connected account
- Redirect URI: `https://app.fieldstay.app/api/kroger/callback`

---

## OwnerRez Integration

### What It Is
A full property management system used by many professional STR operators.
FieldStay uses OwnerRez for booking revenue auto-population in the owner portal.

### Auth
OAuth 2.0. Tokens stored in `integration_connections` table.
Pattern mirrors what's already built — check existing OwnerRez OAuth routes for reference.

### Integration Connections Table Pattern
Used for all third-party OAuth tokens (OwnerRez, future providers):
```typescript
// Storing a token
await supabase.from('integration_connections').upsert({
  org_id,
  provider_id: ownerrezProvider.id,  // from integration_providers table
  access_token:  tokens.access_token,
  refresh_token: tokens.refresh_token,
  expires_at:    new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
}, { onConflict: 'org_id,provider_id' })

// Retrieving a token (in Inngest steps — use service client)
const { data: connection } = await supabase
  .from('integration_connections')
  .select('access_token, refresh_token, expires_at')
  .eq('org_id', org_id)
  .eq('provider_id', OWNERREZ_PROVIDER_ID)
  .single()
```

---

## Mapbox Geocoding

### Pattern (called on property save and vendor save)
```typescript
// lib/geocoding.ts
export async function geocodeZip(
  zip: string
): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN
  const url   = `https://api.mapbox.com/geocoding/v5/mapbox.places/`
              + `${encodeURIComponent(zip)}.json`
              + `?country=US&types=postcode&limit=1&access_token=${token}`

  const res  = await fetch(url)
  if (!res.ok) return null

  const data = await res.json()
  const [lng, lat] = data.features?.[0]?.center ?? []
  return (lat && lng) ? { lat, lng } : null
}
```

### When to Call
- `createProperty` server action — geocode `properties.zip` → store `lat`, `lng`
- `updateProperty` server action — re-geocode only if zip changed
- `createVendor` server action — geocode `vendors.service_zip` → store `lat`, `lng`
- `updateVendor` server action — re-geocode only if service_zip changed

One call per save. Never geocode in a loop or on every render.

---

## Supabase Storage (Vendor Compliance Documents)

### Bucket Setup
Bucket name: `compliance-documents`
Access: private (signed URLs only — never public)

### Upload Pattern (from Server Action)
```typescript
import { createServerClient } from '@/lib/supabase/server'

export async function uploadComplianceDocument(
  vendorId:  string,
  file:      File,
  docType:   string,
): Promise<{ path: string } | { error: string }> {
  const { membership } = await requireOrgMember()
  const supabase = createServerClient()

  const ext  = file.name.split('.').pop()
  const path = `${membership.org_id}/${vendorId}/${docType}-${Date.now()}.${ext}`

  const { error } = await supabase.storage
    .from('compliance-documents')
    .upload(path, file, { upsert: false })

  if (error) return { error: error.message }

  // Store the path in vendor_compliance_documents.document_url
  // Generate signed URL when displaying (1 hour expiry)
  return { path }
}

// Generating a signed URL for display
const { data } = await supabase.storage
  .from('compliance-documents')
  .createSignedUrl(document.document_url, 3600)  // 1 hour
```

---

## Stripe

### Webhook Handler Location
```
app/api/webhooks/stripe/route.ts
```

### Required Pattern — Always Verify First
```typescript
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature')!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Route to Inngest — never do heavy work in the webhook handler itself
  await inngest.send({ name: `stripe/${event.type}`, data: event.data.object })
  return NextResponse.json({ received: true })
}
```

---

## Common Mistakes Claude Code Makes in This Codebase

These are recurring issues to check before committing any code:

1. **`from('memberships')`** — does not exist. Always `from('organization_members')`.

2. **`assigned_crew_id`** — deprecated column on `work_orders`.
   Always use `assigned_crew_member_id`.

3. **Forgetting to add new Inngest functions to the serve handler** in
   `app/api/inngest/route.ts`. The function exists but never runs.

4. **Adding a new table to the DB without adding to PowerSync publication.**
   The client never sees the data. Run:
   ```sql
   ALTER PUBLICATION powersync ADD TABLE my_new_table;
   ```
   Then update `lib/powersync/schema.ts`.

5. **Creating owner_transactions without checking `source_reference_id` first.**
   Causes duplicate expense/revenue entries on Inngest retries.

6. **Using `createServiceClient()` where `createServerClient()` is correct.**
   Service client bypasses RLS — use only in Inngest steps and admin routes.

7. **Calling `inngest.send()` directly from a client component.**
   Always fire Inngest from Server Actions, never client-side.

8. **Hardcoding hex colors instead of CSS variables.**
   `color: '#ffffff'` → `color: 'var(--text-primary)'`

9. **Missing `WITH CHECK` clause on INSERT/UPDATE policies.**
   USING clause alone does not protect INSERT operations.

10. **Writing to `powersync_crew_*` tables directly.**
    These are managed views. Write to the source tables and let PowerSync handle them.
