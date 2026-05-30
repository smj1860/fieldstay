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
