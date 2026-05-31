Install Package
bashnpm install web-push
npm install --save-dev @types/web-push

Files — Complete Change Map
FileActionlib/powersync/schema.tsAdd properties tablelib/powersync/client.tsFix photo_storage_path upload; add inventory count uploadlib/push/client.tsNew — web-push helperpublic/sw.jsNew — service workerapp/crew/crew-shell.tsxRegister service worker + request push permission on mountapp/crew/page.tsxShow property name + address on turnover cardsapp/crew/turnovers/[id]/page.tsxEmbed inventory inline; show property infoapp/api/crew/push-subscribe/route.tsNew — save push subscription to DBapp/(dashboard)/turnovers/actions.tsSend push notification after assignCrew
Do not touch any other file. Specifically:

Do NOT touch app/crew/inventory/[propertyId]/page.tsx — leave it
in place (it can stay as a fallback route), just don't link to it
from the crew app anymore
Do NOT touch the dashboard layout, settings, or any PM-facing pages
Do NOT touch Supabase migration files beyond the SQL in Step C above


Part 1 — Crew App Simplification
lib/powersync/schema.ts
Add a properties table so property name and address are available
offline in SQLite queries:
typescriptconst properties = new Table({
  name:    column.text,
  address: column.text,
  city:    column.text,
  state:   column.text,
})
Add it to AppSchema:
typescriptexport const AppSchema = new Schema({
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
  properties,   // ADD THIS
})
Also add org_id to the turnovers table definition (needed so the
crew inventory insert can read the org):
typescriptconst turnovers = new Table({
  property_id:       column.text,
  org_id:            column.text,   // ADD THIS
  checkout_datetime: column.text,
  checkin_datetime:  column.text,
  window_minutes:    column.integer,
  status:            column.text,
  priority:          column.text,
  notes:             column.text,
})
lib/powersync/client.ts
The uploadData function currently handles checklist_instance_items
(is_completed, crew_notes) and turnovers (status). It is missing
two things:
1. photo_storage_path is not uploaded. When crew takes a photo, the
local SQLite record gets photo_storage_path set, but this never syncs
back to Supabase. Fix by adding photo_storage_path to the update:
typescriptif (op.table === 'checklist_instance_items' && op.op === 'PUT') {
  await this.supabase
    .from('checklist_instance_items')
    .update({
      is_completed:       op.opData?.is_completed,
      crew_notes:         op.opData?.crew_notes,
      photo_storage_path: op.opData?.photo_storage_path ?? null,
    })
    .eq('id', op.id)
}
2. Inventory count updates need to sync. When crew submits a count,
current_quantity is updated locally but never uploads. Add:
typescriptif (op.table === 'inventory_items' && op.op === 'PUT') {
  await this.supabase
    .from('inventory_items')
    .update({ current_quantity: op.opData?.current_quantity })
    .eq('id', op.id)
}
app/crew/page.tsx — Crew Home Page
The current home page shows date/time but no property info. Update the
PowerSync query to join the properties table and show property name
and address on each card.
Update the query type and SQL:
typescripttype TurnoverRow = {
  id:                string
  status:            string
  priority:          string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number | null
  property_id:       string
}

// Join properties via a second query keyed on property_id
// (PowerSync SQLite doesn't support JOIN across tables directly in
// all versions — fetch properties separately and merge in JS)

const turnovers = usePowerSyncQuery<TurnoverRow>(
  `SELECT * FROM turnovers
   WHERE date(checkout_datetime) >= ? AND date(checkout_datetime) <= ?
     AND status != 'completed' AND status != 'cancelled'
   ORDER BY checkout_datetime ASC`,
  [today, weekOut]
)

// Fetch all synced properties once
type PropertyRow = { id: string; name: string; address: string | null; city: string | null; state: string | null }
const properties = usePowerSyncQuery<PropertyRow>('SELECT * FROM properties', [])
const propertyMap = Object.fromEntries((properties ?? []).map((p) => [p.id, p]))
Update the card UI to show:

Property name (bold, prominent)
Address with a tappable <a href="https://maps.google.com/?q=..."> link that opens Maps
Date and time window (already there, keep it)
Priority badge (already there, keep it)

The card should feel like a job brief, not just a timestamp. Property
name should be the most prominent text on the card.
app/crew/turnovers/[id]/page.tsx — Turnover Detail (major rewrite)
This is the main change. The page currently shows: property info →
checklist → action buttons. We are embedding inventory inline so
the full page flow becomes:
Property info card     ← property name, address (tappable), check-in/out window
─────────────────────
Checklist section      ← progress bar, all tasks with photo support (already exists)
─────────────────────
Inventory section      ← all items for this property, +/− counters, par indicators
─────────────────────
Report Issue button    ← already exists
Start / Complete       ← already exists
How to embed inventory:
The inventory data is already in PowerSync. Add a second
usePowerSyncQuery inside the turnover page for inventory items:
typescripttype InvRow = {
  id:               string
  name:             string
  category:         string
  unit:             string
  par_level:        number
  current_quantity: number
  property_id:      string
}

const inventoryItems = usePowerSyncQuery<InvRow>(
  `SELECT * FROM inventory_items
   WHERE property_id = ?
   ORDER BY category, name`,
  [turnover?.property_id ?? '']
)
Add a counts state for the inventory section:
typescriptconst [counts, setCounts] = useState<Record<string, number>>({})
When the crew member changes a count, update PowerSync locally
(which will sync back to Supabase via the uploadData fix above):
typescriptconst handleCountChange = async (itemId: string, newQty: number) => {
  setCounts((prev) => ({ ...prev, [itemId]: newQty }))
  await db.execute(
    'UPDATE inventory_items SET current_quantity = ? WHERE id = ?',
    [newQty, itemId]
  )
}
Remove the POST to /api/crew/inventory-count — it's no longer
needed since PowerSync handles the sync. The local SQLite update +
uploadData is sufficient.
Inventory section UI:
Group items by category (same as the standalone inventory page).
For each item show:

Item name
Par level + unit as subtext
Amber "Low" indicator if current < par_level
+/− buttons and numeric input

Keep it compact — this is a phone screen. Aim for a row height
that lets crew scan quickly. Below the last inventory item, show
a small "Inventory updated" confirmation line (not a submit button
— it saves automatically as they tap).
Property info section:
Add a usePowerSyncQuery for the property:
typescripttype PropertyRow = { id: string; name: string; address: string | null; city: string | null; state: string | null }

const properties = usePowerSyncQuery<PropertyRow>(
  'SELECT * FROM properties WHERE id = ?',
  [turnover?.property_id ?? '']
)
const property = properties?.[0] ?? null
Show at the top of the page:

Property name (large, clear)
Address as a tappable link: <a href={https://maps.google.com/?q=${encodeURIComponent(fullAddress)}`} target="_blank">`
Check-out / next check-in times (already shown, keep them)
Window in hours/minutes (already shown, keep it)

Remove the back link text "Back to Assignments" — replace with
just an ArrowLeft icon button. Saves vertical space and crew
members know what it does.

Part 2 — Push Notifications
lib/push/client.ts — New file
Server-side helper that sends a push notification to all of a
crew member's subscriptions:
typescriptimport webpush from 'web-push'

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_CONTACT_EMAIL}`,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PUBLIC_KEY!
)

export interface PushPayload {
  title: string
  body:  string
  url:   string
}

export async function sendPushToCrewMember(
  subscriptions: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload
): Promise<void> {
  const message = JSON.stringify(payload)

  await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        message
      ).catch((err) => {
        // 410 Gone = subscription expired, log but don't throw
        if (err.statusCode === 410) {
          console.error('[push] expired subscription:', sub.endpoint.slice(-20))
        } else {
          console.error('[push] send failed:', err.statusCode)
        }
      })
    )
  )
}
Use Promise.allSettled — never let a failed push break the
assignment flow. Log errors with minimal context (no full endpoint
URLs, no crew IDs in plain text).
public/sw.js — New file (service worker)
javascriptself.addEventListener('push', (event) => {
  if (!event.data) return

  let data = {}
  try { data = event.data.json() } catch { return }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'FieldStay', {
      body:    data.body  ?? 'You have a new assignment.',
      icon:    '/icons/icon-192x192.png',
      badge:   '/icons/icon-96x96.png',
      data:    { url: data.url ?? '/crew' },
      vibrate: [200, 100, 200],
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/crew'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/crew') && 'focus' in client) {
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
Note: if icon files don't exist at those paths, use a generic path
or remove the icon/badge lines. Do not let a missing icon crash
the notification.
app/crew/crew-shell.tsx — Register service worker + subscribe
The crew shell wraps every crew page. This is where we register
the service worker and request push permission, because it runs
on every crew page load.
Add a useEffect inside the CrewShell client component that:

Registers the service worker (/sw.js)
Checks if the user is already subscribed
If not subscribed, requests permission (browsers only show the
permission prompt once, so this is safe to call on every mount)
If permission granted, subscribes and saves to the server

typescriptuseEffect(() => {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      const existing = await reg.pushManager.getSubscription()
      if (existing) return // already subscribed

      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      })

      const json = sub.toJSON()
      if (!json.keys) return

      await fetch('/api/crew/push-subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          endpoint: json.endpoint,
          p256dh:   json.keys.p256dh,
          auth:     json.keys.auth,
        }),
      })
    } catch (err) {
      // Non-fatal — app works fine without push
      console.error('[push] registration failed:', err)
    }
  }

  register()
}, [])
This must be inside the client component ('use client' already
at the top of crew-shell.tsx). Add the useEffect import if not
already there.
app/api/crew/push-subscribe/route.ts — New file
typescriptimport { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crew) return NextResponse.json({ error: 'Not a crew member' }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body?.endpoint || !body?.p256dh || !body?.auth) {
    return NextResponse.json({ error: 'Invalid subscription data' }, { status: 400 })
  }

  // Upsert — if the endpoint already exists for this crew member, update keys
  await supabase
    .from('push_subscriptions')
    .upsert(
      {
        crew_member_id: crew.id,
        org_id:         crew.org_id,
        endpoint:       body.endpoint,
        p256dh:         body.p256dh,
        auth:           body.auth,
      },
      { onConflict: 'crew_member_id,endpoint' }
    )

  return NextResponse.json({ success: true })
}
app/(dashboard)/turnovers/actions.ts — Send push after assignment
In the assignCrew function, after all assignments and status
updates are complete (after the for loop), add the push send:
typescript// Send push notification to crew member
try {
  const { createServiceClient } = await import('@/lib/supabase/server')
  const serviceClient = createServiceClient()

  const { data: subs } = await serviceClient
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('crew_member_id', crewMemberId)

  if (subs && subs.length > 0) {
    const { sendPushToCrewMember } = await import('@/lib/push/client')

    // Build a summary of what was assigned
    const count = turnovers.length
    const { data: firstTurnover } = await serviceClient
      .from('turnovers')
      .select('checkout_datetime, properties(name)')
      .eq('id', turnovers[0]!.id)
      .single()

    const propName = Array.isArray(firstTurnover?.properties)
      ? firstTurnover.properties[0]?.name
      : (firstTurnover?.properties as { name: string } | null)?.name

    const body = count === 1 && propName
      ? `${propName} — ${new Date(firstTurnover!.checkout_datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : `${count} new assignment${count !== 1 ? 's' : ''} added`

    await sendPushToCrewMember(subs, {
      title: 'New Assignment',
      body,
      url:   '/crew',
    })
  }
} catch (err) {
  // Push failure must never break the assignment
  console.error('[push] failed to notify crew member:', err)
}
Use dynamic imports (await import(...)) for createServiceClient
and sendPushToCrewMember so the action file doesn't pull
web-push into the client bundle. The assignCrew action is a
server action — this is fine — but dynamic imports keep the module
graph clean.

What NOT to Do

Do not add a "Save Inventory" submit button inside the turnover
detail page. Inventory updates save automatically via PowerSync as
the crew member taps +/−. A submit button implies failure states
and requires them to remember to press it. Crew members have 45
minutes to turn a house — don't add a step.
Do not block the turnover complete action on inventory. Inventory
count is a best-effort task. If a crew member hasn't touched the
inventory section, still allow them to mark the turnover complete.
Do not show a push permission prompt before the page loads.
The useEffect in crew-shell.tsx runs after mount. Never call
Notification.requestPermission() synchronously or in a server
component — it will throw.
Do not send push notifications synchronously before returning
from assignCrew. The entire push block must be wrapped in
try/catch. If it fails for any reason (no subscriptions, VAPID
misconfigured, network error), the assignment must still complete
successfully.
Do not store VAPID private key in any client component, prop,
or NEXT_PUBLIC_ env var. VAPID_PUBLIC_KEY (the private key,
confusingly named) is server-only. Only NEXT_PUBLIC_VAPID_PUBLIC_KEY
goes to the browser.
Do not navigate crew to a separate inventory route. The
/crew/inventory/[propertyId] page can stay in the codebase but
remove any links to it from the main crew flow. Everything is
embedded now.
Do not add any new tabs, nav items, or bottom bars to the crew
shell. One header, one scrollable page per job. That's it.


Verification Checklist
Manual steps completed before coding:

 VAPID keys generated and added to Vercel env vars
 PowerSync sync rule for properties added in dashboard
 SQL migration run in Supabase (push_subscriptions table)
 npm install web-push @types/web-push run

Build check:

 npm run build passes with zero TypeScript errors

Functional checks:

 Crew home page shows property name on each turnover card
 Property address is tappable and opens Maps app
 Turnover detail page shows property name at top
 Checklist is embedded and functional (all existing behavior preserved)
 Inventory section appears below checklist on turnover detail page
 +/− buttons update counts immediately
 Low stock indicator shows on items below par level
 Inventory changes sync back to Supabase (verify in Supabase table editor)
 photo_storage_path syncs back after photo is taken (verify in Supabase)
 Report Issue modal still works
 Mark Complete still works
 Service worker registers on crew pages (check browser DevTools → Application → Service Workers)
 Push subscription saves to push_subscriptions table on first crew login
 Assigning a crew member to a turnover triggers a push notification on their device
 Tapping the notification opens the crew app
 Push failure does not prevent turnover assignment from completing


Notes

The PowerSync properties sync only works after the sync rule is
added in the dashboard (Step B). Until then, usePowerSyncQuery
on properties will return an empty array — property name will
show as blank on cards. This is not a code error; it just means
Step B hasn't been done yet.
The NEXT_PUBLIC_VAPID_PUBLIC_KEY env var in the browser needs
to be a Uint8Array for pushManager.subscribe. Convert it inline:

typescript  function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = window.atob(base64)
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
  }

  applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!)
Add this helper function in crew-shell.tsx near the useEffect.

iOS Safari requires the app to be added to the Home Screen (PWA
installed) before push notifications work. This is an OS-level
limitation, not a code issue. Android Chrome works without
installation.


# NEW UPDATED CLAUDE.md — FieldStay: Quote Request Rearchitecture

## Context

The current quote request system has a structural flaw: it stores one
quote on the work order itself (`quote_token`, `quoted_amount`, etc. as
columns on `work_orders`) and locks the WO into a `quote_requested`
status while waiting. This prevents sending to multiple vendors
simultaneously, which is standard practice in property management.

This task replaces that design with a proper `quote_requests` table —
one row per vendor per work order — so PMs can solicit quotes from
multiple vendors at once, compare them side by side, and approve one.

---

## ⚠️ SQL — Stephen runs this in Supabase BEFORE Claude Code touches anything

```sql
-- 1. Create status enum for quote requests
CREATE TYPE quote_request_status AS ENUM (
  'pending',    -- sent to vendor, waiting for response
  'submitted',  -- vendor submitted a quote amount
  'approved',   -- PM approved this quote (WO assigned to this vendor)
  'declined',   -- PM declined this quote
  'expired'     -- token expired without vendor responding
);

-- 2. Create the quote_requests table
CREATE TABLE public.quote_requests (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id          UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id              UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status                 quote_request_status NOT NULL DEFAULT 'pending',
  quote_token            TEXT UNIQUE NOT NULL,
  quote_token_expires_at TIMESTAMPTZ NOT NULL,
  quoted_amount          NUMERIC(10,2),
  quote_notes            TEXT,
  sent_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Indexes
CREATE INDEX idx_quote_requests_work_order_id ON quote_requests(work_order_id);
CREATE INDEX idx_quote_requests_vendor_id     ON quote_requests(vendor_id);
CREATE INDEX idx_quote_requests_org_id        ON quote_requests(org_id);
CREATE INDEX idx_quote_requests_token
  ON quote_requests(quote_token);

-- 4. RLS
ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view quote requests"
  ON quote_requests FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "Admins and managers can manage quote requests"
  ON quote_requests FOR ALL
  USING (is_org_member(org_id, ARRAY['admin','manager']::member_role[]));

-- 5. Drop old quote columns from work_orders
--    (data is not migrated — these were never used in production)
ALTER TABLE work_orders
  DROP COLUMN IF EXISTS quote_token,
  DROP COLUMN IF EXISTS quote_token_expires_at,
  DROP COLUMN IF EXISTS quoted_amount,
  DROP COLUMN IF EXISTS quote_notes;

-- NOTE: The 'quote_requested' value in the wo_status enum is intentionally
-- left in place. Removing enum values in Postgres requires recreating the
-- type which is complex. It will simply be unused going forward.
```

---

## Scope — 10 files, no new files created

| File | Change |
|------|--------|
| `types/database.ts` | Add `QuoteRequestStatus` type + `QuoteRequest` interface; remove old quote fields from `WorkOrder` |
| `app/(dashboard)/maintenance/actions.ts` | Remove `requestVendorQuote` + `approveVendorQuote`; add `sendQuoteRequests`, `approveQuoteRequest`, `declineQuoteRequest` |
| `app/(dashboard)/maintenance/[id]/page.tsx` | Add `quote_requests` query; pass to `WorkOrderDetail` |
| `app/(dashboard)/maintenance/[id]/work-order-detail.tsx` | Replace `QuotePanel` with `QuotesPanel`; remove old quote props |
| `app/api/work-orders/[token]/quote/route.ts` | Look up by `quote_requests.quote_token` instead of `work_orders.quote_token` |
| `app/work-orders/[token]/quote/page.tsx` | Fetch quote_request by token; join WO info |
| `app/work-orders/[token]/vendor-portal.tsx` | `VendorQuotePortal` checks `quoteRequest.status` not `workOrder.status` |
| `lib/inngest/events.ts` | Add `quote_request_id` to both quote event data shapes |
| `lib/inngest/functions/work-order-events.ts` | Update both quote handlers to read from `quote_requests` table |

**Do not touch any other file.**

---

## 1 — `types/database.ts`

Add after the existing type definitions at the top of the file:

```typescript
export type QuoteRequestStatus = 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
```

Add the `QuoteRequest` interface (place it near the other interfaces,
after `WorkOrderPhoto`):

```typescript
export interface QuoteRequest {
  id:                     string
  work_order_id:          string
  org_id:                 string
  vendor_id:              string
  status:                 QuoteRequestStatus
  quote_token:            string
  quote_token_expires_at: string
  quoted_amount:          number | null
  quote_notes:            string | null
  sent_at:                string
  submitted_at:           string | null
  created_at:             string
}
```

Remove these four fields from the `WorkOrder` interface — they no
longer exist on the table:

```typescript
// REMOVE these four lines:
quote_token: string | null
quote_token_expires_at: string | null
quoted_amount: number | null
quote_notes: string | null
```

---

## 2 — `app/(dashboard)/maintenance/actions.ts`

**Remove** the following two functions entirely:
- `requestVendorQuote`
- `approveVendorQuote`

**Add** these three functions at the end of the file:

```typescript
// ── Send quote requests to multiple vendors ───────────────────────────────────

export async function sendQuoteRequests(
  workOrderId: string,
  vendorIds: string[]
): Promise<{ error?: string; sent: number }> {
  const { supabase, membership } = await requireOrgMember()

  if (!vendorIds.length) return { error: 'Select at least one vendor', sent: 0 }

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, property_id, status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found', sent: 0 }
  if (wo.status === 'completed' || wo.status === 'cancelled') {
    return { error: 'Cannot request quotes on a completed or cancelled work order', sent: 0 }
  }

  // Skip vendors who already have a pending or submitted quote for this WO
  const { data: existing } = await supabase
    .from('quote_requests')
    .select('vendor_id')
    .eq('work_order_id', workOrderId)
    .in('status', ['pending', 'submitted'])

  const existingVendorIds = new Set((existing ?? []).map((r) => r.vendor_id))
  const toSend = vendorIds.filter((id) => !existingVendorIds.has(id))

  if (!toSend.length) {
    return { error: 'All selected vendors already have an active quote request', sent: 0 }
  }

  let sent = 0

  for (const vendorId of toSend) {
    const quote_token            = crypto.randomUUID().replace(/-/g, '')
    const quote_token_expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: qr, error } = await supabase
      .from('quote_requests')
      .insert({
        work_order_id: workOrderId,
        org_id:        membership.org_id,
        vendor_id:     vendorId,
        quote_token,
        quote_token_expires_at,
        status:        'pending',
      })
      .select('id')
      .single()

    if (error || !qr) continue

    await inngest.send({
      name: 'work-order/quote-requested',
      data: {
        work_order_id:    workOrderId,
        quote_request_id: qr.id,
        property_id:      wo.property_id,
        org_id:           membership.org_id,
        vendor_id:        vendorId,
        quote_token,
      },
    })

    sent++
  }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return { sent }
}

// ── Approve one quote — assign WO, decline all others ────────────────────────

export async function approveQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, work_order_id, vendor_id, quoted_amount, status, org_id')
    .eq('id', quoteRequestId)
    .eq('org_id', membership.org_id)
    .single()

  if (!qr) return { error: 'Quote request not found' }
  if (qr.status !== 'submitted') return { error: 'Can only approve a quote that has been submitted by the vendor' }

  // Mark this one approved
  await supabase
    .from('quote_requests')
    .update({ status: 'approved' })
    .eq('id', quoteRequestId)

  // Decline all other pending/submitted quotes for this WO
  await supabase
    .from('quote_requests')
    .update({ status: 'declined' })
    .eq('work_order_id', qr.work_order_id)
    .neq('id', quoteRequestId)
    .in('status', ['pending', 'submitted'])

  // Assign vendor to WO, generate completion portal, move to assigned
  const completion_token            = crypto.randomUUID().replace(/-/g, '')
  const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('work_orders')
    .update({
      vendor_id:                  qr.vendor_id,
      status:                     'assigned',
      estimated_cost:             qr.quoted_amount ?? undefined,
      portal_enabled:             true,
      completion_token,
      completion_token_expires_at,
    })
    .eq('id', qr.work_order_id)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await supabase.from('work_order_updates').insert({
    work_order_id:             qr.work_order_id,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               'pending',
    status_to:                 'assigned',
    notes:                     `Quote approved — $${qr.quoted_amount?.toFixed(2) ?? '?'}. Vendor assigned and notified.`,
  })

  // Notify vendor via existing work-order/created Inngest event
  await inngest.send({
    name: 'work-order/created',
    data: {
      work_order_id:  qr.work_order_id,
      property_id:    '',   // Inngest handler fetches this from DB
      org_id:         membership.org_id,
      vendor_id:      qr.vendor_id,
      portal_enabled: true,
    },
  })

  revalidatePath(`/maintenance/${qr.work_order_id}`)
  revalidatePath('/maintenance')
  return {}
}

// ── Decline a single quote request ────────────────────────────────────────────

export async function declineQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, work_order_id')
    .eq('id', quoteRequestId)
    .eq('org_id', membership.org_id)
    .single()

  if (!qr) return { error: 'Quote request not found' }

  await supabase
    .from('quote_requests')
    .update({ status: 'declined' })
    .eq('id', quoteRequestId)

  revalidatePath(`/maintenance/${qr.work_order_id}`)
  return {}
}
```

---

## 3 — `app/(dashboard)/maintenance/[id]/page.tsx`

Add a fourth parallel query to fetch quote requests with vendor info:

```typescript
const [
  { data: wo },
  { data: updates },
  { data: photos },
  { data: quoteRequests },   // ADD THIS
  { data: vendors },
] = await Promise.all([
  // ... existing queries unchanged ...

  // ADD: quote requests for this WO
  supabase
    .from('quote_requests')
    .select('id, vendor_id, status, quoted_amount, quote_notes, sent_at, submitted_at, quote_token, quote_token_expires_at, vendors(id, name, specialty, email)')
    .eq('work_order_id', id)
    .order('created_at', { ascending: true }),

  // ... vendors query unchanged ...
])
```

Pass `quoteRequests` to `WorkOrderDetail`:
```tsx
<WorkOrderDetail
  workOrder={wo as never}
  updates={updates ?? []}
  photos={photos ?? []}
  quoteRequests={(quoteRequests ?? []) as never}
  vendors={vendors ?? []}
/>
```

---

## 4 — `app/(dashboard)/maintenance/[id]/work-order-detail.tsx`

### Types

Remove `quote_token`, `quote_token_expires_at`, `quoted_amount`,
`quote_notes` from the `WorkOrderDetailProps` interface.

Add a `QuoteRequest` local interface:

```typescript
interface QuoteRequestRow {
  id:                     string
  vendor_id:              string
  status:                 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
  quoted_amount:          number | null
  quote_notes:            string | null
  sent_at:                string
  submitted_at:           string | null
  quote_token:            string
  quote_token_expires_at: string
  vendors: { id: string; name: string; specialty: string; email: string | null } | null
}
```

### Imports

Add to the action imports:
```typescript
import { sendQuoteRequests, approveQuoteRequest, declineQuoteRequest } from '../actions'
```

Remove `requestVendorQuote` and `approveVendorQuote` from imports.

### Replace `QuotePanel` with `QuotesPanel`

Delete the existing `QuotePanel` function entirely. Replace it with this:

```typescript
// ── Quotes Panel ──────────────────────────────────────────────────────────────

const QUOTE_STATUS_LABELS: Record<QuoteRequestRow['status'], string> = {
  pending:   'Awaiting Response',
  submitted: 'Quote Received',
  approved:  'Approved',
  declined:  'Declined',
  expired:   'Expired',
}

const QUOTE_STATUS_BADGE: Record<QuoteRequestRow['status'], string> = {
  pending:   'badge-slate',
  submitted: 'badge-gold',
  approved:  'badge-green',
  declined:  'badge-slate',
  expired:   'badge-red',
}

function QuotesPanel({
  workOrder,
  quoteRequests,
  vendors,
}: {
  workOrder:     { id: string; status: string }
  quoteRequests: QuoteRequestRow[]
  vendors:       { id: string; name: string; specialty: string }[]
}) {
  const [showForm,    setShowForm]    = useState(false)
  const [selected,    setSelected]    = useState<string[]>([])
  const [sending,     startSend]      = useTransition()
  const [approving,   setApproving]   = useState<string | null>(null)
  const [declining,   setDeclining]   = useState<string | null>(null)
  const [err,         setErr]         = useState<string | null>(null)

  const canRequest = !['completed', 'cancelled'].includes(workOrder.status)
  const activeVendorIds = new Set(
    quoteRequests
      .filter((q) => q.status === 'pending' || q.status === 'submitted')
      .map((q) => q.vendor_id)
  )
  const availableVendors = vendors.filter((v) => !activeVendorIds.has(v.id))

  const handleSend = () => {
    if (!selected.length) return
    startSend(async () => {
      const r = await sendQuoteRequests(workOrder.id, selected)
      if (r.error) { setErr(r.error); return }
      setSelected([])
      setShowForm(false)
      setErr(null)
    })
  }

  const handleApprove = (quoteRequestId: string) => {
    setApproving(quoteRequestId)
    startSend(async () => {
      const r = await approveQuoteRequest(quoteRequestId)
      if (r.error) setErr(r.error)
      setApproving(null)
    })
  }

  const handleDecline = (quoteRequestId: string) => {
    setDeclining(quoteRequestId)
    startSend(async () => {
      const r = await declineQuoteRequest(quoteRequestId)
      if (r.error) setErr(r.error)
      setDeclining(null)
    })
  }

  // Don't render panel at all if no quotes exist and WO can't accept new ones
  if (!quoteRequests.length && !canRequest) return null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <MessageSquareDollar className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          <h3 className="section-header mb-0">Quote Requests</h3>
          {quoteRequests.length > 0 && (
            <span className="badge badge-slate">{quoteRequests.length}</span>
          )}
        </div>
        {canRequest && availableVendors.length > 0 && (
          <button onClick={() => setShowForm((v) => !v)} className="btn-secondary text-xs py-1.5 px-2.5">
            <Plus className="w-3 h-3" />
            Request Quotes
          </button>
        )}
      </div>

      {err && (
        <div className="text-xs rounded px-3 py-2 mb-3"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {err}
        </div>
      )}

      {/* Vendor selection form */}
      {showForm && (
        <div className="mb-4 p-3 rounded-xl border border-themed space-y-3"
             style={{ background: 'var(--bg-canvas)' }}>
          <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Select vendors to receive an RFQ:
          </p>
          <div className="space-y-1.5">
            {availableVendors.map((v) => (
              <label key={v.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(v.id)}
                  onChange={(e) => {
                    setSelected((prev) =>
                      e.target.checked ? [...prev, v.id] : prev.filter((id) => id !== v.id)
                    )
                  }}
                  className="rounded"
                />
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{v.name}</span>
                <span className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
                  {v.specialty.replace('_', ' ')}
                </span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSend}
              disabled={!selected.length || sending}
              className="btn-primary text-sm"
            >
              {sending
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
                : `Send to ${selected.length || ''} Vendor${selected.length !== 1 ? 's' : ''}`
              }
            </button>
            <button onClick={() => { setShowForm(false); setSelected([]) }} className="btn-ghost text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Quote requests list */}
      {quoteRequests.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No quote requests yet. Request quotes from one or more vendors before assigning.
        </p>
      ) : (
        <div className="space-y-2">
          {quoteRequests.map((qr) => {
            const vendor   = Array.isArray(qr.vendors) ? qr.vendors[0] : qr.vendors
            const isExpired = new Date(qr.quote_token_expires_at) < new Date()
            const portalUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/work-orders/${qr.quote_token}/quote`

            return (
              <div
                key={qr.id}
                className="flex items-start gap-3 p-3 rounded-xl border border-themed"
                style={{ background: 'var(--bg-raised)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {vendor?.name ?? '—'}
                    </span>
                    <span className={cn('badge', QUOTE_STATUS_BADGE[isExpired && qr.status === 'pending' ? 'expired' : qr.status])}>
                      {QUOTE_STATUS_LABELS[isExpired && qr.status === 'pending' ? 'expired' : qr.status]}
                    </span>
                  </div>

                  {qr.quoted_amount != null && (
                    <p className="text-lg font-bold" style={{ color: 'var(--accent-gold)' }}>
                      ${qr.quoted_amount.toFixed(2)}
                    </p>
                  )}
                  {qr.quote_notes && (
                    <p className="text-xs italic mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {qr.quote_notes}
                    </p>
                  )}
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Sent {formatDate(qr.sent_at)}
                    {qr.submitted_at && ` · Received ${formatDate(qr.submitted_at)}`}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  {qr.status === 'submitted' && (
                    <button
                      onClick={() => handleApprove(qr.id)}
                      disabled={approving === qr.id}
                      className="btn-primary text-xs py-1.5 px-2.5 whitespace-nowrap"
                    >
                      {approving === qr.id ? <Loader2 className="w-3 h-3 animate-spin" /> : '✓ Approve'}
                    </button>
                  )}
                  {(qr.status === 'pending' || qr.status === 'submitted') && (
                    <button
                      onClick={() => handleDecline(qr.id)}
                      disabled={declining === qr.id}
                      className="btn-danger text-xs py-1.5 px-2.5"
                    >
                      {declining === qr.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Decline'}
                    </button>
                  )}
                  {qr.status === 'pending' && !isExpired && (
                    <button
                      onClick={() => navigator.clipboard.writeText(portalUrl)}
                      className="btn-ghost text-xs py-1.5 px-2.5 whitespace-nowrap"
                      title="Copy vendor portal link"
                    >
                      Copy Link
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

### Update `WorkOrderDetail` component

Add `quoteRequests` prop:

```typescript
export function WorkOrderDetail({
  workOrder,
  updates,
  photos,
  quoteRequests = [],   // ADD
  vendors = [],
}: {
  workOrder:     WorkOrderDetailProps
  updates:       WorkOrderUpdate[]
  photos:        WorkOrderPhoto[]
  quoteRequests: QuoteRequestRow[]   // ADD
  vendors?:      { id: string; name: string; specialty: string }[]
})
```

Replace the call to `<QuotePanel workOrder={workOrder} />` with:

```tsx
<QuotesPanel
  workOrder={{ id: workOrder.id, status: workOrder.status }}
  quoteRequests={quoteRequests}
  vendors={vendors}
/>
```

Add `Plus` and `MessageSquareDollar` to the lucide-react imports if
not already present. Remove `MessageSquareDot` import if it was only
used by the old `QuotePanel`.

---

## 5 — `app/api/work-orders/[token]/quote/route.ts`

Rewrite entirely. Look up by `quote_requests.quote_token` instead
of `work_orders.quote_token`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { inngest }                   from '@/lib/inngest/client'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token }  = await params
  const supabase   = createServiceClient()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select(`
      id, status, quote_token_expires_at,
      work_orders (
        id, title, description, scheduled_date, estimated_cost,
        properties (name, city, state)
      )
    `)
    .eq('quote_token', token)
    .single()

  if (!qr) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const wo = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders

  return NextResponse.json({
    quoteRequest: {
      id:                     qr.id,
      status:                 qr.status,
      quote_token_expires_at: qr.quote_token_expires_at,
    },
    workOrder: wo,
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token }  = await params
  const supabase   = createServiceClient()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, org_id, work_order_id, status, quote_token_expires_at')
    .eq('quote_token', token)
    .single()

  if (!qr) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })

  if (qr.status !== 'pending') {
    return NextResponse.json({ error: 'This quote request is no longer active' }, { status: 409 })
  }

  if (new Date(qr.quote_token_expires_at) < new Date()) {
    await supabase.from('quote_requests').update({ status: 'expired' }).eq('id', qr.id)
    return NextResponse.json({ error: 'This quote link has expired' }, { status: 410 })
  }

  const body          = await request.json().catch(() => ({})) as { amount?: number; notes?: string }
  const quoted_amount = parseFloat(String(body.amount ?? 0))
  const quote_notes   = (body.notes as string | undefined)?.trim() || null

  if (!quoted_amount || quoted_amount <= 0) {
    return NextResponse.json({ error: 'A valid quote amount is required' }, { status: 400 })
  }

  await supabase
    .from('quote_requests')
    .update({
      status:       'submitted',
      quoted_amount,
      quote_notes,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', qr.id)

  await supabase.from('work_order_updates').insert({
    work_order_id:             qr.work_order_id,
    org_id:                    qr.org_id,
    updated_via_vendor_portal: true,
    status_from:               null,
    status_to:                 null,
    notes: `Vendor submitted quote: $${quoted_amount.toFixed(2)}${quote_notes ? ` — ${quote_notes}` : ''}`,
  })

  await inngest.send({
    name: 'work-order/quote-submitted' as const,
    data: {
      work_order_id:    qr.work_order_id,
      quote_request_id: qr.id,
      org_id:           qr.org_id,
      quoted_amount,
      quote_notes,
    },
  })

  return NextResponse.json({ success: true })
}
```

---

## 6 — `app/work-orders/[token]/quote/page.tsx`

Rewrite to fetch from `quote_requests`:

```typescript
import { createServiceClient } from '@/lib/supabase/server'
import { VendorQuotePortal }   from '../vendor-portal'

interface Props { params: Promise<{ token: string }> }

export default async function QuotePortalPage({ params }: Props) {
  const { token }  = await params
  const supabase   = createServiceClient()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select(`
      id, status, quote_token_expires_at,
      work_orders (
        id, title, description, scheduled_date, estimated_cost,
        properties (name, city, state)
      )
    `)
    .eq('quote_token', token)
    .single()

  if (!qr) {
    return (
      <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Not Found</h2>
          <p className="text-sm text-accent-500">This quote link is invalid or has been removed.</p>
        </div>
      </div>
    )
  }

  const wo       = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders
  const property = wo && (Array.isArray(wo.properties) ? wo.properties[0] : wo.properties)
  const expired  = new Date(qr.quote_token_expires_at) < new Date()

  return (
    <VendorQuotePortal
      token={token}
      quoteRequestStatus={qr.status}
      workOrder={{
        id:             wo?.id ?? '',
        title:          wo?.title ?? '',
        description:    wo?.description ?? null,
        scheduled_date: wo?.scheduled_date ?? null,
        estimated_cost: wo?.estimated_cost ?? null,
      }}
      property={property ?? null}
      expired={expired}
    />
  )
}
```

---

## 7 — `app/work-orders/[token]/vendor-portal.tsx`

Update `VendorQuotePortal` to accept `quoteRequestStatus` as a prop
instead of checking `workOrder.status`:

```typescript
// Change the props interface — add quoteRequestStatus, remove status from workOrder
export function VendorQuotePortal({
  token,
  quoteRequestStatus,   // NEW — replaces workOrder.status check
  workOrder,
  property,
  expired,
}: {
  token:                string
  quoteRequestStatus:   string   // 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
  workOrder:            WorkOrderInfo   // remove 'status' from WorkOrderInfo if it was there
  property:             PropertyInfo | null
  expired:              boolean
})
```

Inside the component, update the `alreadyQuoted` check:

```typescript
// BEFORE:
const alreadyQuoted = workOrder.status !== 'quote_requested'

// AFTER:
const alreadyQuoted = quoteRequestStatus !== 'pending'
```

Remove `status` from `WorkOrderInfo` interface if it was only used
for this check.

---

## 8 — `lib/inngest/events.ts`

Add `quote_request_id` to both quote event data shapes:

```typescript
'work-order/quote-requested': {
  data: {
    work_order_id:    string
    quote_request_id: string   // ADD
    property_id:      string
    org_id:           string
    vendor_id:        string
    quote_token:      string
  }
}

'work-order/quote-submitted': {
  data: {
    work_order_id:    string
    quote_request_id: string   // ADD
    org_id:           string
    quoted_amount:    number
    quote_notes:      string | null
  }
}
```

---

## 9 — `lib/inngest/functions/work-order-events.ts`

### `handleWorkOrderQuoteRequested`

This function currently fetches `quote_token` from `work_orders`.
Update it to fetch from `quote_requests` using `quote_request_id`:

```typescript
async ({ event, step, logger }) => {
  const { work_order_id, quote_request_id, vendor_id } = event.data

  await step.run('send-vendor-quote-request', async () => {
    const supabase = createServiceClient()

    // Fetch quote request and WO info together
    const { data: qr } = await supabase
      .from('quote_requests')
      .select(`
        id, quote_token, status,
        work_orders (
          id, title, description, scheduled_date, estimated_cost,
          properties (name, city, state)
        ),
        vendors (name, email)
      `)
      .eq('id', quote_request_id)
      .single()

    if (!qr?.quote_token) return

    const wo       = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders
    const vendor   = Array.isArray(qr.vendors)     ? qr.vendors[0]     : qr.vendors
    const property = wo && (Array.isArray(wo.properties) ? wo.properties[0] : wo.properties)

    if (!vendor?.email) {
      logger.warn(`Quote request ${quote_request_id}: vendor has no email`)
      return
    }

    const quoteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/work-orders/${qr.quote_token}/quote`

    // ... rest of email send logic unchanged, just use the variables above
  })
}
```

### `handleWorkOrderQuoteSubmitted`

Update to fetch `quoted_amount` from `quote_requests` using
`quote_request_id` (it's already in the event data, so this just
means using `event.data.quote_request_id` if you need to look up
additional context):

```typescript
async ({ event, step }) => {
  const { work_order_id, org_id, quoted_amount, quote_notes, quote_request_id } = event.data
  // Rest of the function is unchanged — it already has quoted_amount in the event data
  // Just destructure quote_request_id in case it's needed for future use
}
```

---

## Verification Checklist

- [ ] `npm run build` passes with zero TypeScript errors
- [ ] Work order detail page shows "Quote Requests" panel
- [ ] "Request Quotes" button appears on pending WOs
- [ ] Selecting multiple vendors and clicking Send fires one RFQ per vendor
- [ ] Each vendor receives their own unique portal link via email
- [ ] Vendor submits quote → status updates to "Quote Received" in the panel
- [ ] Multiple quotes received → all shown side by side with amounts
- [ ] Approving one quote → WO moves to `assigned`, other quotes auto-declined
- [ ] Declining a single quote → only that request declined, others unaffected
- [ ] Vendor portal page loads correctly via `/work-orders/[token]/quote`
- [ ] Already-submitted quote shows "This quote request is no longer active" if vendor tries to resubmit
- [ ] `quote_requested` WO status no longer appears anywhere in the new flow
- [ ] No TypeScript errors referencing removed WorkOrder quote fields

## Notes

- The `quote_requested` value in `wo_status` remains in the database enum
  but is not used by any new code. Do not try to remove it from the enum
  — that requires recreating the type in Postgres and is not worth the risk.
- The WO status stays `pending` while quotes are being gathered.
  The status only moves to `assigned` when a quote is approved.
- The `Copy Link` button on pending quote requests lets PMs manually
  share the portal link if the email didn't arrive.
- `availableVendors` filters out vendors who already have an active
  (pending or submitted) quote request, preventing duplicate RFQs
  to the same vendor.
