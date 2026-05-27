# CLAUDE.md — FieldStay: Issues 1–4

Read this entire file before writing any code. Complete the four issues
in order. Test each before moving to the next.

---

## Issue 1 — Inventory Items from Setup Wizard Not Appearing in Inventory Tab

### Root cause

In `inventory-setup.tsx` the "Save & Continue" / complete button calls
`completeInventoryStep(propertyId)` directly. That action only marks the
setup step complete and redirects — it does NOT save items. Items a PM
adds from the catalog or custom form go into local React state (`isDirty: true`)
but are never persisted if the user clicks Continue without first clicking
Save. Items are lost.

### Fix — `app/(dashboard)/properties/[id]/setup/inventory/inventory-setup.tsx`

Find the complete button handler. It currently looks like:

```tsx
onClick={() => startComplete(() => completeInventoryStep(propertyId))}
```

Replace with a handler that saves dirty items first:

```tsx
onClick={() => startComplete(async () => {
  const dirty = items.filter((i) => i.isDirty)
  if (dirty.length > 0) {
    const result = await upsertInventoryItems(propertyId, dirty)
    if (result.error) {
      setError(result.error)
      return
    }
    setItems((prev) => prev.map((i) => ({ ...i, isDirty: false, isNew: false })))
  }
  await completeInventoryStep(propertyId)
})}
```

This auto-saves any unsaved items before completing the step so nothing
is lost regardless of whether the PM clicked the separate Save button.

---

## Issue 2 — Maintenance Schedule UX + Work Order Edit/Notes

### 2a — Fix prefill so suggestion chips actually populate the form

**File:** `app/(dashboard)/properties/[id]/setup/maintenance/maintenance-form.tsx`

The `prefill` function currently ignores its parameters — it opens the
form but doesn't set any values. The `ROUTINE_SUGGESTIONS` and
`SEASONAL_SUGGESTIONS` arrays already exist and are correct, but
clicking them does nothing useful.

Add controlled state variables for the form fields and wire them up:

```tsx
// Add these state declarations after existing useState calls:
const [prefilledName, setPrefilledName]           = useState('')
const [prefilledFrequency, setPrefilledFrequency] = useState('quarterly')
const [prefilledMonth, setPrefilledMonth]         = useState<number | ''>('')

// Replace the broken prefill function with:
const prefill = (values: Partial<{ name: string; frequency: string; month_due: number }>) => {
  setPrefilledName(values.name ?? '')
  setPrefilledFrequency(values.frequency ?? 'quarterly')
  setPrefilledMonth(values.month_due ?? '')
  setSchedType(values.month_due !== undefined ? 'seasonal' : 'routine')
  setShowForm(true)
}

// Add a resetPrefill helper called when the form is closed/submitted:
const resetPrefill = () => {
  setPrefilledName('')
  setPrefilledFrequency('quarterly')
  setPrefilledMonth('')
}
```

Then update the form inputs to use these values. Change the name input:

```tsx
// Before:
<input name="name" type="text" required className="input" ... />

// After:
<input
  name="name"
  type="text"
  required
  className="input"
  value={prefilledName}
  onChange={(e) => setPrefilledName(e.target.value)}
  placeholder="e.g. HVAC Filter Change"
/>
```

Change the frequency select:

```tsx
<select
  name="frequency"
  className="input"
  value={prefilledFrequency}
  onChange={(e) => setPrefilledFrequency(e.target.value)}
>
  {FREQUENCIES.map((f) => (
    <option key={f.value} value={f.value}>{f.label}</option>
  ))}
</select>
```

Change the month select (for seasonal):

```tsx
<select
  name="month_due"
  className="input"
  value={prefilledMonth}
  onChange={(e) => setPrefilledMonth(e.target.value ? Number(e.target.value) : '')}
>
  <option value="">Select month…</option>
  {MONTHS.map((m, i) => (
    <option key={i + 1} value={i + 1}>{m}</option>
  ))}
</select>
```

Call `resetPrefill()` when the form is submitted successfully or closed.

### 2b — Work order edit button + edit action

**File:** `app/(dashboard)/maintenance/actions.ts`

Add a new server action after `createWorkOrder`:

```ts
export async function updateWorkOrder(
  workOrderId: string,
  data: {
    title:           string
    description:     string | null
    priority:        string
    vendor_id:       string | null
    scheduled_date:  string | null
    estimated_cost:  number | null
    portal_enabled:  boolean
  }
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      title:          data.title,
      description:    data.description || null,
      priority:       data.priority as never,
      vendor_id:      data.vendor_id || null,
      scheduled_date: data.scheduled_date || null,
      estimated_cost: data.estimated_cost || null,
      portal_enabled: data.portal_enabled,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return {}
}
```

**File:** `app/(dashboard)/maintenance/[id]/work-order-detail.tsx`

Add an edit button next to the Cancel button in the WO header actions area.
The edit button opens an inline edit form (not a separate page) with the
current values pre-populated:

```tsx
// Add edit state at the top of the component with other state:
const [editing, setEditing] = useState(false)
const [editError, setEditError] = useState<string | null>(null)
const [saving, setSaving] = useState(false)

// Edit form submit handler:
const handleEditSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()
  setSaving(true)
  setEditError(null)
  const fd = new FormData(e.currentTarget)
  const result = await updateWorkOrder(workOrder.id, {
    title:          fd.get('title') as string,
    description:    fd.get('description') as string | null,
    priority:       fd.get('priority') as string,
    vendor_id:      fd.get('vendor_id') as string | null,
    scheduled_date: fd.get('scheduled_date') as string | null,
    estimated_cost: fd.get('estimated_cost')
      ? parseFloat(fd.get('estimated_cost') as string)
      : null,
    portal_enabled: fd.get('portal_enabled') === 'true',
  })
  setSaving(false)
  if (result.error) { setEditError(result.error); return }
  setEditing(false)
}
```

When `editing` is true, render an edit form panel above the work order
detail with fields for: Title, Description, Priority, Vendor, Scheduled
Date, Estimated Cost, Portal Enabled toggle. The form has Save and
Cancel buttons.

Add an "Edit" button (pencil icon) in the work order header alongside
the existing Cancel work order button:

```tsx
// Add Edit button (only show when WO is not completed or cancelled):
{!['completed', 'cancelled'].includes(workOrder.status) && (
  <button
    onClick={() => setEditing(!editing)}
    className="btn-secondary text-sm flex items-center gap-1.5"
  >
    <Pencil className="w-3.5 h-3.5" />
    {editing ? 'Close Edit' : 'Edit'}
  </button>
)}
```

Import `Pencil` from lucide-react.

### 2c — Work order notes thread (PM can add notes any time)

The current UI only allows completion notes. PMs need to add notes
throughout the life of a WO — questions for vendors, reminders, updates.

**File:** `app/(dashboard)/maintenance/actions.ts`

Add a new action:

```ts
export async function addWorkOrderNote(
  workOrderId: string,
  note: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  // Verify ownership
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, org_id')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found' }

  await supabase.from('work_order_updates').insert({
    work_order_id:           workOrderId,
    org_id:                  membership.org_id,
    updated_by_user_id:      (await supabase.auth.getUser()).data.user?.id ?? null,
    updated_via_vendor_portal: false,
    status_from:             null,
    status_to:               null,
    notes:                   note.trim(),
  })

  revalidatePath(`/maintenance/${workOrderId}`)
  return {}
}
```

**File:** `app/(dashboard)/maintenance/[id]/work-order-detail.tsx`

Add a notes section below the work order description and above the
status history. It should have:
- A compact textarea with a "Add Note" button
- The existing `work_order_updates` timeline already shows `u.notes`
  for each entry — so added notes will appear inline with status changes

```tsx
// Add state:
const [noteText, setNoteText]   = useState('')
const [addingNote, setAddingNote] = useState(false)

const handleAddNote = async () => {
  if (!noteText.trim()) return
  setAddingNote(true)
  await addWorkOrderNote(workOrder.id, noteText)
  setNoteText('')
  setAddingNote(false)
}
```

Render below the description section:

```tsx
<div className="mt-4">
  <h3 className="section-header mb-2">Add Note</h3>
  <div className="flex gap-2">
    <textarea
      rows={2}
      value={noteText}
      onChange={(e) => setNoteText(e.target.value)}
      className="input resize-none flex-1 text-sm"
      placeholder="Add a note, question for vendor, or update…"
    />
    <button
      onClick={handleAddNote}
      disabled={addingNote || !noteText.trim()}
      className="btn-secondary self-end px-3 py-2 text-sm"
    >
      {addingNote ? '…' : 'Add'}
    </button>
  </div>
</div>
```

---

## Issue 3 — Settings Showing Wrong Plan (Starter / 2 Properties)

### 3a — Fix onboarding default plan

**File:** `app/onboarding/actions.ts`

Change lines 37–40 from:

```ts
plan:           'starter',
plan_status:    'trialing',
trial_ends_at:  new Date(Date.now() + 14 * 86_400_000).toISOString(),
max_properties: 5,
```

To:

```ts
plan:           'pro',
plan_status:    'trialing',
trial_ends_at:  new Date(Date.now() + 14 * 86_400_000).toISOString(),
max_properties: 15,
```

### 3b — Fix settings plan display

**File:** `app/(dashboard)/settings/settings-tabs.tsx`

Update the `PLAN_INFO` constant — `starter` is no longer a real plan.
Change it to reflect current pricing, or remove it and update the fallback:

```ts
const PLAN_INFO = {
  pro:        { name: 'Pro',        maxProperties: 15,  description: 'Up to 15 properties',  badge: 'badge-blue'  },
  growth:     { name: 'Growth',     maxProperties: 45,  description: '16–45 properties',     badge: 'badge-green' },
  enterprise: { name: 'Enterprise', maxProperties: 999, description: '45+ properties',       badge: 'badge-amber' },
  // Keep starter for any legacy accounts but point to pro values:
  starter:    { name: 'Pro',        maxProperties: 15,  description: 'Up to 15 properties',  badge: 'badge-blue'  },
} as const
```

Update the fallback on line 103 and line 693 from:

```ts
?? PLAN_INFO.starter
```

To:

```ts
?? PLAN_INFO.pro
```

Also update the existing org in the database directly — run in Supabase
SQL Editor to fix any accounts already created with 'starter':

```sql
UPDATE organizations
SET plan = 'pro', max_properties = 15
WHERE plan = 'starter';
```

---


## Verification Checklist

After completing all four issues:

**Issue 1:**
- [ ] Add items from catalog in inventory setup wizard
- [ ] Click Continue WITHOUT clicking Save first
- [ ] Go to main Inventory tab — all items should appear

**Issue 2:**
- [ ] In maintenance setup wizard, click a routine suggestion chip
      (e.g. "HVAC Filter Change") — form should open pre-filled with
      that name and quarterly frequency
- [ ] Click a seasonal suggestion (e.g. "Pool Opening") — form should
      open with correct month pre-filled
- [ ] Create a work order — Edit button appears in WO detail
- [ ] Click Edit — can change title, description, priority, save works
- [ ] Add a note in WO detail — appears in the updates timeline

**Issue 3:**
- [ ] Sign up fresh → complete onboarding → Settings → Billing shows
      "Pro" plan with "Up to 15 properties" (not Starter / 2 properties)
- [ ] Existing accounts updated in DB via SQL

