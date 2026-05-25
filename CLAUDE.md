# CLAUDE.md — FieldStay

Complete reference for working on this codebase. Read every section before
writing any code or running any commands.

---

## Current State — Where We Are

**90 source files. The PM-facing product is complete.**

Every dashboard feature is built and working:

| Feature | Status |
|---------|--------|
| Auth (signup, login, onboarding) | ✅ Complete |
| Properties CRUD + 7-step setup wizard | ✅ Complete |
| Turnovers board + detail + crew assignment | ✅ Complete |
| Checklist instances created on turnover generation | ✅ Complete |
| Inventory management + catalog picker + PO history | ✅ Complete |
| Maintenance — work order board + WO detail + schedule management | ✅ Complete |
| Communications — sent guest message log | ✅ Complete |
| Owners — add owners, generate portal links, transaction P&L | ✅ Complete |
| Settings — org, crew, vendors, Stripe billing | ✅ Complete |
| Owner portal (tokenized P&L view) | ✅ Complete |
| Vendor portal (tokenized WO completion) | ✅ Complete |
| Inngest pipeline — iCal sync, emails, POs, alerts (10 functions) | ✅ Complete |
| middleware.ts — route protection | ✅ Fixed |
| Auto-create booking revenue transactions | ✅ Complete |
| Auto-create WO expense transactions | ✅ Complete |
| Manual transaction entry in owners dashboard | ✅ Complete |
| Crew app (PowerSync offline) | ⬜ Not built |

**One remaining feature: the crew offline app.**

---

## Two Things to Fix Before Crew App

### Fix A — Migration file missing two columns

The code references `properties.avg_nightly_rate` and
`owner_transactions.booking_id` but neither column exists in
`fieldstay_migration_v1.sql`. Anyone running a fresh migration gets a
database without these columns and the code fails.

**Create a new file `fieldstay_migration_v2.sql` in the repo root:**

```sql
-- FieldStay Migration v2
-- Run this AFTER fieldstay_migration_v1.sql

-- avg_nightly_rate on properties (booking revenue auto-calculation)
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- booking_id on owner_transactions (link revenue record to the booking)
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id
  ON owner_transactions(booking_id);
```

Run this in Supabase SQL Editor on the existing project (the two columns are
already missing from the live database if it was created from v1 only).

### Fix B — New property form missing avg_nightly_rate

The edit form (setup wizard step 1) has the nightly rate field but the
initial "Add Property" form does not. When a PM creates a new property they
can't set the rate until they re-enter the wizard.

**Edit:** `app/(dashboard)/properties/new/new-property-form.tsx`

After the check-in/check-out time grid, add:

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
    className="input"
    placeholder="e.g. 285.00"
  />
  <p className="text-xs text-accent-400 mt-1">
    Used to auto-calculate booking revenue in the owner portal. Can be set later.
  </p>
</div>
```

**Edit:** `app/(dashboard)/properties/actions.ts`

In `createProperty`, parse and include `avg_nightly_rate`:

```ts
const avg_nightly_rate = formData.get('avg_nightly_rate')
  ? parseFloat(formData.get('avg_nightly_rate') as string)
  : null

// Add to the insert payload:
avg_nightly_rate,
```

---

## The Remaining Feature: Crew App

The crew-facing offline PWA at `/crew`. Currently a stub with a TODO comment.

Cleaning crew use this on-site to view assigned turnovers, complete
checklists room-by-room, and submit inventory counts — all without reliable
internet via PowerSync.

The crew layout and auth check already exist (`app/crew/layout.tsx`). What's
needed is the PowerSync integration and the actual pages.

### Architecture

PowerSync keeps a local SQLite database on the device, synced from Supabase.
Reads are from SQLite (always available, even offline). Writes queue locally
and sync to Supabase when internet returns.

**What syncs to each crew member's device:**
- Their assigned turnovers (today + next 7 days)
- Checklist instances + items for those turnovers
- Inventory items for their assigned properties

**What they write back (synced when online):**
- Checklist item completions (`is_completed`, `crew_notes`)
- Turnover status changes (`in_progress`, `completed`)
- Inventory count submissions

### Step 1 — Create PowerSync schema

**New file:** `lib/powersync/schema.ts`

```ts
import { Column, ColumnType, Schema, Table } from '@powersync/web'

const turnovers = new Table({
  property_id:       new Column({ type: ColumnType.TEXT }),
  checkout_datetime: new Column({ type: ColumnType.TEXT }),
  checkin_datetime:  new Column({ type: ColumnType.TEXT }),
  window_minutes:    new Column({ type: ColumnType.INTEGER }),
  status:            new Column({ type: ColumnType.TEXT }),
  priority:          new Column({ type: ColumnType.TEXT }),
  notes:             new Column({ type: ColumnType.TEXT }),
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
  turnovers,
  checklist_instances,
  checklist_instance_items,
  inventory_items,
])
```

### Step 2 — Create PowerSync client

**New file:** `lib/powersync/client.ts`

```ts
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
      // Crew marks checklist items complete
      if (op.table === 'checklist_instance_items' && op.op === 'PUT') {
        await this.supabase
          .from('checklist_instance_items')
          .update({
            is_completed: op.opData?.is_completed,
            crew_notes:   op.opData?.crew_notes,
          })
          .eq('id', op.id)
      }
      // Crew updates turnover status
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

### Step 3 — Wrap crew layout with PowerSync context

**Edit:** `app/crew/layout.tsx`

The layout is currently a server component that does auth verification.
Restructure it so the auth check stays server-side but the PowerSync
provider wraps the client content:

```tsx
// app/crew/layout.tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CrewShell } from './crew-shell'  // new client component

export default async function CrewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .single()
  if (!crew) redirect('/login')

  return <CrewShell crewName={crew.name}>{children}</CrewShell>
}
```

**New file:** `app/crew/crew-shell.tsx`

```tsx
'use client'
import { PowerSyncContext } from '@powersync/react'
import { getPowerSyncDb } from '@/lib/powersync/client'

export function CrewShell({
  crewName,
  children,
}: {
  crewName: string
  children: React.ReactNode
}) {
  const db = getPowerSyncDb()

  return (
    <PowerSyncContext.Provider value={db}>
      <div className="min-h-screen bg-accent-50 flex flex-col max-w-lg mx-auto">
        <header className="bg-brand-800 text-white px-4 py-4 flex items-center justify-between sticky top-0 z-10">
          <div>
            <span className="font-bold text-lg">FieldStay Crew</span>
            <p className="text-brand-200 text-xs">{crewName}</p>
          </div>
          <SyncStatus />
        </header>
        <main className="flex-1 px-4 py-6">{children}</main>
      </div>
    </PowerSyncContext.Provider>
  )
}

function SyncStatus() {
  const { syncStatus } = usePowerSync()   // from @powersync/react
  const syncing = syncStatus?.connected

  if (syncing) return null
  return (
    <span className="bg-amber-400 text-amber-900 text-xs font-medium px-2 py-1 rounded-full">
      Offline
    </span>
  )
}
```

### Step 4 — Crew dashboard (today's assignments)

**Replace:** `app/crew/page.tsx`

```tsx
'use client'
import { usePowerSyncQuery } from '@powersync/react'
import Link from 'next/link'
import { formatWindow } from '@/lib/utils'
import { CalendarCheck, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function CrewDashboardPage() {
  const today    = new Date().toISOString().split('T')[0]
  const weekOut  = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]

  const { data: turnovers } = usePowerSyncQuery(
    `SELECT * FROM turnovers
     WHERE date(checkout_datetime) >= ? AND date(checkout_datetime) <= ?
       AND status != 'completed' AND status != 'cancelled'
     ORDER BY checkout_datetime ASC`,
    [today, weekOut]
  )

  if (!turnovers?.length) {
    return (
      <div className="text-center py-20">
        <CalendarCheck className="w-10 h-10 text-accent-300 mx-auto mb-3" />
        <p className="font-semibold text-accent-700">No upcoming assignments</p>
        <p className="text-sm text-accent-400 mt-1">You're all caught up.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-accent-900">My Assignments</h2>
      {turnovers.map((t) => {
        const checkout = new Date(t.checkout_datetime)
        const isToday  = checkout.toDateString() === new Date().toDateString()
        const isUrgent = t.priority === 'urgent' || t.priority === 'high'

        return (
          <Link
            key={t.id}
            href={`/crew/turnovers/${t.id}`}
            className={cn(
              'block bg-white rounded-xl border p-4 transition-shadow hover:shadow-card-md',
              isUrgent ? 'border-amber-300' : 'border-accent-200'
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className={cn(
                'text-xs font-semibold px-2 py-0.5 rounded-full',
                t.status === 'assigned'    ? 'bg-blue-50 text-blue-700' :
                t.status === 'in_progress' ? 'bg-purple-50 text-purple-700' :
                'bg-accent-100 text-accent-600'
              )}>
                {t.status === 'assigned' ? 'Assigned' :
                 t.status === 'in_progress' ? 'In Progress' : t.status}
              </span>
              {isUrgent && (
                <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-accent-600">
              <span className="font-medium text-accent-800">
                {isToday ? 'Today' : checkout.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span>·</span>
              <span>{checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              {t.window_minutes && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatWindow(t.window_minutes)}
                  </span>
                </>
              )}
            </div>
          </Link>
        )
      })}
    </div>
  )
}
```

### Step 5 — Turnover detail + checklist

**New directory:** `app/crew/turnovers/[id]/`

**New file:** `app/crew/turnovers/[id]/page.tsx`

```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Camera, CheckCircle2, Circle } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import Link from 'next/link'

export default function CrewTurnoverPage() {
  const { id } = useParams<{ id: string }>()
  const router  = useRouter()
  const db      = usePowerSync()

  // Fetch turnover
  const { data: turnovers } = usePowerSyncQuery(
    'SELECT * FROM turnovers WHERE id = ?', [id]
  )
  const turnover = turnovers?.[0]

  // Fetch checklist instance for this turnover
  const { data: instances } = usePowerSyncQuery(
    'SELECT * FROM checklist_instances WHERE turnover_id = ?', [id]
  )
  const instance = instances?.[0]

  // Fetch checklist items
  const { data: items } = usePowerSyncQuery(
    `SELECT * FROM checklist_instance_items WHERE instance_id = ?
     ORDER BY section_name, sort_order`,
    [instance?.id ?? '']
  )

  const completedCount = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount     = items?.length ?? 0

  // Group by section
  const sections = (items ?? []).reduce<Record<string, typeof items>>((acc, item) => {
    if (!acc[item.section_name]) acc[item.section_name] = []
    acc[item.section_name]!.push(item)
    return acc
  }, {})

  const toggleItem = async (itemId: string, current: number) => {
    await db.execute(
      'UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?',
      [current ? 0 : 1, itemId]
    )
  }

  const markInProgress = async () => {
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['in_progress', id])
  }

  const markComplete = async () => {
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['completed', id])
    router.push('/crew')
  }

  if (!turnover) return <div className="text-center py-20 text-accent-400">Loading…</div>

  return (
    <div>
      <Link href="/crew" className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-600 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back
      </Link>

      {/* Header */}
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
            <span className="text-sm font-medium text-accent-600">
              {Math.floor(turnover.window_minutes / 60)}h {turnover.window_minutes % 60}m window
            </span>
          )}
        </div>
        <div className="text-sm text-accent-600 space-y-1">
          <p><span className="text-accent-400">Checkout:</span> {formatDateTime(turnover.checkout_datetime)}</p>
          <p><span className="text-accent-400">Check-in:</span> {formatDateTime(turnover.checkin_datetime)}</p>
        </div>
        {turnover.notes && (
          <p className="mt-2 text-sm text-accent-600 bg-amber-50 rounded-lg px-3 py-2">
            📝 {turnover.notes}
          </p>
        )}
      </div>

      {/* Checklist progress */}
      {totalCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-semibold text-accent-700">
              Checklist — {completedCount}/{totalCount}
            </span>
            <span className="text-sm text-accent-500">
              {Math.round((completedCount / totalCount) * 100)}%
            </span>
          </div>
          <div className="h-2 bg-accent-100 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                completedCount === totalCount ? 'bg-green-500' : 'bg-brand-600'
              )}
              style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Sections */}
      {Object.entries(sections).map(([section, sectionItems]) => (
        <div key={section} className="mb-4">
          <h3 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2">
            {section}
          </h3>
          <div className="bg-white rounded-xl border border-accent-200 divide-y divide-accent-100 overflow-hidden">
            {sectionItems!.map((item) => (
              <button
                key={item.id}
                onClick={() => toggleItem(item.id, item.is_completed)}
                className={cn(
                  'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors',
                  item.is_completed ? 'bg-green-50' : 'hover:bg-accent-50'
                )}
              >
                {item.is_completed
                  ? <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                  : <Circle className="w-5 h-5 text-accent-300 flex-shrink-0 mt-0.5" />
                }
                <span className={cn(
                  'text-sm',
                  item.is_completed ? 'text-green-700 line-through' : 'text-accent-800'
                )}>
                  {item.task}
                </span>
                {item.requires_photo && (
                  <Camera className={cn(
                    'w-4 h-4 flex-shrink-0 ml-auto',
                    item.photo_storage_path ? 'text-green-500' : 'text-accent-300'
                  )} />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}

      {totalCount === 0 && (
        <div className="bg-white rounded-xl border border-accent-200 p-6 text-center text-accent-400 text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pb-8">
        {turnover.status === 'assigned' && (
          <button onClick={markInProgress} className="btn-secondary w-full py-3">
            Start Turnover
          </button>
        )}
        <button
          onClick={markComplete}
          disabled={turnover.status === 'completed'}
          className="btn-primary w-full py-3"
        >
          {turnover.status === 'completed' ? '✓ Complete' : 'Mark as Complete'}
        </button>
      </div>
    </div>
  )
}
```

### Step 6 — Inventory count page (offline)

**New file:** `app/crew/inventory/[propertyId]/page.tsx`

```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import type { InventoryCategory } from '@/types/database'

export default function CrewInventoryPage() {
  const { propertyId } = useParams<{ propertyId: string }>()
  const db     = usePowerSync()
  const router = useRouter()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [notes, setNotes] = useState('')

  const { data: items } = usePowerSyncQuery(
    `SELECT * FROM inventory_items WHERE property_id = ? ORDER BY category, name`,
    [propertyId]
  )

  const handleSubmit = async () => {
    setSubmitting(true)
    // Write counts back to local SQLite — PowerSync syncs to Supabase
    for (const [itemId, qty] of Object.entries(counts)) {
      await db.execute(
        'UPDATE inventory_items SET current_quantity = ? WHERE id = ?',
        [qty, itemId]
      )
    }
    // Also fire the server action via fetch to create the count record + trigger Inngest
    await fetch('/api/crew/inventory-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId, counts, notes }),
    })
    router.push('/crew')
  }

  // ... render items grouped by category with quantity inputs
}
```

**New file:** `app/api/crew/inventory-count/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { propertyId, counts, notes } = await request.json()

  // Get crew member record
  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crew) return NextResponse.json({ error: 'Not a crew member' }, { status: 403 })

  // Create inventory_count record
  const { data: count } = await supabase
    .from('inventory_counts')
    .insert({
      property_id:         propertyId,
      org_id:              crew.org_id,
      submitted_by_crew_id: crew.id,
      notes,
    })
    .select('id')
    .single()

  if (!count) return NextResponse.json({ error: 'Failed' }, { status: 500 })

  // Insert count items
  const items = Object.entries(counts as Record<string, number>).map(([id, qty]) => ({
    count_id:           count.id,
    inventory_item_id:  id,
    quantity_counted:   qty,
  }))

  if (items.length > 0) {
    await supabase.from('inventory_count_items').insert(items)

    // Update current quantities
    for (const { inventory_item_id, quantity_counted } of items) {
      await supabase
        .from('inventory_items')
        .update({ current_quantity: quantity_counted })
        .eq('id', inventory_item_id)
        .eq('org_id', crew.org_id)
    }
  }

  // Fire Inngest to check par levels and generate PO if needed
  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: count.id, property_id: propertyId, org_id: crew.org_id },
  })

  return NextResponse.json({ success: true })
}
```

### Step 7 — PowerSync sync rules

Configure these in the PowerSync dashboard (not in code). They define what
each crew member's device receives based on their assignments:

```yaml
bucket_definitions:
  crew_turnovers:
    parameters: []
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

  crew_checklists:
    parameters: []
    data:
      - table: checklist_instances
        where: >
          turnover_id IN (
            SELECT ta.turnover_id
            FROM turnover_assignments ta
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )
      - table: checklist_instance_items
        where: >
          instance_id IN (
            SELECT ci.id
            FROM checklist_instances ci
            JOIN turnover_assignments ta ON ci.turnover_id = ta.turnover_id
            JOIN crew_members cm ON ta.crew_member_id = cm.id
            WHERE cm.user_id = token_parameters.user_id
          )

  crew_inventory:
    parameters: []
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

---

## What Needs Discussion

### 1 — Photo upload for checklist items that require_photo

The checklist has a `requires_photo` flag per item. Crew can see which items
need photos but there's no implementation for capturing/uploading them yet.

**Two options:**
- **Simple:** Use `<input type="file" accept="image/*" capture="environment">`
  which triggers the native camera on mobile. Upload to Supabase Storage via
  a fetch call, store the path in `checklist_instance_items.photo_storage_path`.
- **Complex:** Queue the upload locally when offline, sync the file when online.
  This requires more PowerSync work.

The simple approach is fine for v1.

### 2 — Crew gets invited vs. self-service signup

Currently the Settings page lets PMs add crew members with name/email/phone.
But for a crew member to USE the app (login, get PowerSync sync), they need
a Supabase Auth account with their `user_id` linked to `crew_members.user_id`.

**The gap:** There's no invite flow. A PM adds Maria to their crew roster but
Maria has no way to create an account that gets linked to that crew record.

**Options:**
a) PM invites crew via email → crew clicks link → signs up → their user_id
   gets linked to the crew record (similar to org member invite flow)
b) Crew signs up at a specific URL → system links them by email match

Option (a) is cleaner. The `organization_members` table has an invite token
pattern already — same approach for crew members.

### 3 — Deployment: are services set up?

Before the app can go live:
- Supabase project created + migration run?
- Inngest app set up and functions tested?
- Resend domain verified?
- Stripe products + prices created?
- PowerSync instance connected to Supabase?
- Vercel project + env vars configured?

---

## Repository Structure (Current)

```
fieldstay/
├── middleware.ts                    ✅ Route protection
├── fieldstay_migration_v1.sql       ✅ Run in Supabase (+ v2 migration needed)
├── package.json + config files      ✅
│
├── types/database.ts                ✅ All tables typed (incl. avg_nightly_rate, booking_id)
│
├── lib/
│   ├── auth.ts                      ✅
│   ├── utils.ts                     ✅
│   ├── wizard.ts                    ✅
│   ├── ical/parser.ts               ✅
│   ├── turnovers/generator.ts       ✅ Creates checklist instances on turnover generation
│   ├── supabase/{server,client,middleware}.ts  ✅
│   ├── inngest/
│   │   ├── client.ts + events.ts    ✅
│   │   └── functions/ (10 functions)  ✅ All registered
│   ├── resend/client.ts             ✅
│   ├── stripe/client.ts             ✅
│   └── powersync/                   ⬜ NOT BUILT YET
│
├── app/
│   ├── (auth)/                      ✅ login + signup
│   ├── onboarding/                  ✅
│   ├── (dashboard)/
│   │   ├── properties/              ✅ (new form missing avg_nightly_rate — Fix B)
│   │   ├── turnovers/               ✅
│   │   ├── inventory/               ✅ catalog picker included
│   │   ├── maintenance/             ✅
│   │   ├── communications/          ✅
│   │   ├── owners/                  ✅ transaction P&L included
│   │   └── settings/                ✅
│   ├── owner/[token]/               ✅ Full P&L view
│   ├── work-orders/[token]/         ✅ Vendor portal
│   ├── crew/                        ⬜ STUB — build using guide above
│   └── api/                         ✅ inngest + stripe + work-order completion
```

---

## Code Patterns — Required Reading

### Auth (every server component + server action)

```ts
const { user, supabase, membership } = await requireOrgMember()
// Always filter by membership.org_id
const { property, supabase, membership } = await requireProperty(propertyId)
```

### Service client (background jobs + tokenized routes ONLY)

```ts
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Bypasses RLS — never in dashboard pages or server actions
```

### Pre-built CSS — always use these first

```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
.section-header  .page-title  .page-subtitle  .page-header
```

### Crew pages — PowerSync pattern

```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'

// Read (offline-capable):
const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])

// Write (queued offline, syncs when online):
const db = usePowerSync()
await db.execute('UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?', [1, id])
```

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()` (validates JWT server-side)
3. Never forget `revalidatePath()` after mutations
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`

---

## Database Reference

```
organizations → organization_members → auth.users
             → properties (avg_nightly_rate)
                  → ical_feeds → bookings → turnovers
                  │                └── turnover_assignments → crew_members
                  │                └── checklist_instances → checklist_instance_items
                  → inventory_items → inventory_counts
                  → purchase_orders → purchase_order_items
                  → work_orders → work_order_updates, work_order_photos
                  → maintenance_schedules
                  → guest_message_templates
                  → property_owners → owner_portal_tokens
                  └── owner_transactions (booking_id, work_order_id)
```

---

## Inngest Pipeline (Complete)

```
cron (4h)  → sync iCal → bookings + turnovers + checklist instances + revenue txns
cron (8am) → maintenance check → alerts or auto work orders
booking    → confirmation email → sleepUntil → pre-checkout email
turnover   → crew notification → sleepUntil 24h → unassigned warning
count      → apply quantities → below par → PO + PM email
work order → vendor portal link → on complete → PM alert + expense txn
```

---

## Deployment Checklist

- [ ] v2 migration run (`fieldstay_migration_v2.sql`)
- [ ] All env vars in Vercel project settings
- [ ] Storage buckets: `turnover-photos`, `work-order-photos`, `crew-uploads`
- [ ] Inngest functions registered and tested
- [ ] Stripe webhook: `https://app.fieldstay.com/api/webhooks/stripe`
- [ ] Resend domain `fieldstay.com` verified
- [ ] PowerSync instance connected to Supabase (before crew app goes live)
