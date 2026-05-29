# CLAUDE.md — FieldStay: 5 Feature Changes

Read every section before writing a single line of code. Map all
changes to files, then implement in the order listed. Run
`npm run build` after completing all changes.

---

## Overview

Five independent feature areas, touching 6 files:

| # | Feature | File(s) |
|---|---------|---------|
| 1 | Add/edit/delete maintenance schedules | `maintenance/actions.ts`, `maintenance/maintenance-board.tsx` |
| 2 | Vendor modal: email + phone both required | `vendors/vendors-client.tsx` |
| 3 | Crew modal: email OR phone required | `crew-manage/crew-manage-client.tsx` |
| 4 | Inventory: unit editable on catalog items | `inventory/inventory-manager.tsx` |
| 5 | Inventory: par level supports 0.5 increments | `inventory/inventory-manager.tsx`, `inventory/actions.ts` |

---

## 1 — Add/Edit/Delete Maintenance Schedules

### Background

The `maintenance_schedules` table exists and has full schema support.
The `SchedulesSection` component in `maintenance-board.tsx` displays
existing schedules but there is **no way to create, edit, or delete
them** — only to manually trigger a WO from one. This change adds
full CRUD for schedules with automation options.

The `maintenance_schedules` table columns to know:
- `name` text NOT NULL
- `property_id` uuid
- `assigned_vendor_id` uuid (nullable)
- `schedule_type` — `'routine'` | `'seasonal'`
- `frequency` — `'weekly'|'biweekly'|'monthly'|'quarterly'|'semi_annual'|'annual'` (routine only)
- `month_due` integer 1–12 (seasonal only — which month it recurs)
- `estimated_cost` numeric
- `instructions` text
- `auto_create_wo` boolean — if true, Inngest auto-creates a WO when due
- `next_due_date` date
- `is_active` boolean

### 1a — `app/(dashboard)/maintenance/actions.ts`

Add three new server actions at the end of the file (inside
the module, after all existing exports):

```typescript
// ── Create Maintenance Schedule ──────────────────────────────────────────────

export async function createMaintenanceSchedule(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name              = (formData.get('name') as string)?.trim()
  const property_id       = formData.get('property_id') as string
  const schedule_type     = (formData.get('schedule_type') as string) || 'routine'
  const frequency         = (formData.get('frequency') as string) || null
  const month_due         = formData.get('month_due') ? parseInt(formData.get('month_due') as string, 10) : null
  const assigned_vendor_id = (formData.get('assigned_vendor_id') as string) || null
  const estimated_cost    = formData.get('estimated_cost') ? parseFloat(formData.get('estimated_cost') as string) : null
  const instructions      = (formData.get('instructions') as string)?.trim() || null
  const auto_create_wo    = formData.get('auto_create_wo') === 'true'
  const next_due_date     = (formData.get('next_due_date') as string) || null

  if (!name)        return { error: 'Name is required' }
  if (!property_id) return { error: 'Property is required' }
  if (schedule_type === 'routine' && !frequency) return { error: 'Frequency is required for routine schedules' }
  if (schedule_type === 'seasonal' && !month_due) return { error: 'Month is required for seasonal schedules' }

  const { error } = await supabase
    .from('maintenance_schedules')
    .insert({
      name,
      property_id,
      org_id:              membership.org_id,
      schedule_type:       schedule_type as never,
      frequency:           schedule_type === 'routine' ? (frequency as never) : null,
      month_due:           schedule_type === 'seasonal' ? month_due : null,
      assigned_vendor_id:  assigned_vendor_id || null,
      estimated_cost,
      instructions,
      auto_create_wo,
      next_due_date:       next_due_date || null,
      is_active:           true,
    })

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return { success: true }
}

// ── Update Maintenance Schedule ──────────────────────────────────────────────

export async function updateMaintenanceSchedule(
  scheduleId: string,
  data: {
    name: string
    assigned_vendor_id: string | null
    schedule_type: string
    frequency: string | null
    month_due: number | null
    estimated_cost: number | null
    instructions: string | null
    auto_create_wo: boolean
    next_due_date: string | null
    is_active: boolean
  }
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('maintenance_schedules')
    .update({
      name:                data.name,
      assigned_vendor_id:  data.assigned_vendor_id || null,
      schedule_type:       data.schedule_type as never,
      frequency:           data.schedule_type === 'routine' ? (data.frequency as never) : null,
      month_due:           data.schedule_type === 'seasonal' ? data.month_due : null,
      estimated_cost:      data.estimated_cost,
      instructions:        data.instructions || null,
      auto_create_wo:      data.auto_create_wo,
      next_due_date:       data.next_due_date || null,
      is_active:           data.is_active,
    })
    .eq('id', scheduleId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return {}
}

// ── Delete Maintenance Schedule ──────────────────────────────────────────────

export async function deleteMaintenanceSchedule(
  scheduleId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  // Soft-delete: set is_active = false
  const { error } = await supabase
    .from('maintenance_schedules')
    .update({ is_active: false })
    .eq('id', scheduleId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return {}
}
```

### 1b — `app/(dashboard)/maintenance/maintenance-board.tsx`

**Import additions** — Add to the existing import block:

```typescript
import { createWorkOrder, createWorkOrderFromSchedule, createMaintenanceSchedule, updateMaintenanceSchedule, deleteMaintenanceSchedule } from './actions'
```

Also add `useActionState` to the React import if not already there:
```typescript
import { useState, useTransition, useActionState } from 'react'
```

And add `Pencil, Trash2, ToggleLeft, ToggleRight` to the lucide-react imports if not present.

**Add the `AddScheduleModal` component** — Insert this as a new component
in the file, just before the `SchedulesSection` function. It renders a
modal form for creating a new schedule:

```typescript
// ── Add Schedule Modal ────────────────────────────────────────────────────────

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function AddScheduleModal({
  properties,
  vendors,
  onClose,
}: {
  properties: PropertyOption[]
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(createMaintenanceSchedule, null)
  const [scheduleType, setScheduleType] = useState<'routine' | 'seasonal'>('routine')
  const [autoCreate, setAutoCreate]     = useState(false)

  if (state?.success) { onClose(); return null }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overflow-y-auto">
      <div className="bg-card-themed rounded-2xl shadow-dark-lg w-full max-w-lg p-6 my-4">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Add Maintenance Schedule</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-4"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
            {state.error}
          </div>
        )}

        <form action={action} className="space-y-4">
          {/* Hidden fields */}
          <input type="hidden" name="auto_create_wo" value={String(autoCreate)} />

          <div>
            <label className="label">Task Name <span className="text-red-500">*</span></label>
            <input name="name" type="text" required className="input"
                   placeholder="e.g. HVAC Filter Replacement, Gutter Cleaning" />
          </div>

          <div>
            <label className="label">Property <span className="text-red-500">*</span></label>
            <select name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Schedule type toggle */}
          <div>
            <label className="label">Schedule Type</label>
            <div className="flex gap-2">
              {(['routine', 'seasonal'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setScheduleType(t)}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize',
                    scheduleType === t
                      ? 'border-transparent text-white'
                      : 'bg-canvas-themed border-themed text-secondary-themed hover:text-primary-themed'
                  )}
                  style={scheduleType === t ? { background: 'var(--accent-gold)', color: '#0a1628' } : undefined}
                >
                  {t}
                </button>
              ))}
            </div>
            <input type="hidden" name="schedule_type" value={scheduleType} />
            <p className="text-xs text-muted-themed mt-1.5">
              {scheduleType === 'routine'
                ? 'Repeats on a set interval (e.g. every month, every quarter)'
                : 'Occurs once per year in a specific month (e.g. winterization every November)'}
            </p>
          </div>

          {/* Routine: frequency */}
          {scheduleType === 'routine' && (
            <div>
              <label className="label">Frequency <span className="text-red-500">*</span></label>
              <select name="frequency" required className="input">
                <option value="">Select frequency…</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly (every 2 weeks)</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="semi_annual">Semi-annual (twice a year)</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          )}

          {/* Seasonal: month */}
          {scheduleType === 'seasonal' && (
            <div>
              <label className="label">Month Due <span className="text-red-500">*</span></label>
              <select name="month_due" required className="input">
                <option value="">Select month…</option>
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Next Due Date</label>
            <input name="next_due_date" type="date" className="input" />
            <p className="text-xs text-muted-themed mt-1">
              Leave blank to set later. Required for auto work order creation to work.
            </p>
          </div>

          <div>
            <label className="label">Assigned Vendor</label>
            <select name="assigned_vendor_id" className="input">
              <option value="">No vendor assigned</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Estimated Cost</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-themed text-sm">$</span>
                <input name="estimated_cost" type="number" min="0" step="0.01"
                       className="input pl-7" placeholder="0.00" />
              </div>
            </div>
          </div>

          <div>
            <label className="label">Instructions / Notes</label>
            <textarea name="instructions" rows={2} className="input resize-none"
                      placeholder="Specific instructions, vendor notes, parts needed…" />
          </div>

          {/* Auto work order toggle */}
          <div
            className="flex items-start gap-3 p-3 rounded-xl cursor-pointer select-none"
            style={{
              background: autoCreate ? 'var(--accent-green-dim)' : 'var(--bg-canvas)',
              border: `1px solid ${autoCreate ? 'rgba(47,217,140,0.3)' : 'var(--border)'}`,
            }}
            onClick={() => setAutoCreate((v) => !v)}
          >
            <div className="flex-shrink-0 mt-0.5">
              {autoCreate
                ? <ToggleRight className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
                : <ToggleLeft className="w-5 h-5 text-muted-themed" />}
            </div>
            <div>
              <p className="text-sm font-medium text-primary-themed">
                Automatically create work orders
              </p>
              <p className="text-xs text-muted-themed mt-0.5">
                {autoCreate
                  ? 'A work order will be created automatically when this task is due (7 days before). If a vendor is assigned, they will be notified.'
                  : 'You will receive an alert email when this task is due, but work orders must be created manually.'}
              </p>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Saving…' : 'Add Schedule'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

**Add an `EditScheduleModal` component** — Insert directly after `AddScheduleModal`.
This allows editing an existing schedule inline:

```typescript
// ── Edit Schedule Modal ───────────────────────────────────────────────────────

function EditScheduleModal({
  schedule,
  vendors,
  onClose,
}: {
  schedule: ScheduleRow
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [scheduleType, setScheduleType] = useState<'routine' | 'seasonal'>(schedule.schedule_type)
  const [autoCreate, setAutoCreate]     = useState(schedule.auto_create_wo)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const fd = new FormData(e.currentTarget)
    const result = await updateMaintenanceSchedule(schedule.id, {
      name:                (fd.get('name') as string).trim(),
      assigned_vendor_id:  (fd.get('assigned_vendor_id') as string) || null,
      schedule_type:       scheduleType,
      frequency:           scheduleType === 'routine' ? (fd.get('frequency') as string) : null,
      month_due:           scheduleType === 'seasonal' && fd.get('month_due')
                             ? parseInt(fd.get('month_due') as string, 10) : null,
      estimated_cost:      fd.get('estimated_cost') ? parseFloat(fd.get('estimated_cost') as string) : null,
      instructions:        (fd.get('instructions') as string)?.trim() || null,
      auto_create_wo:      autoCreate,
      next_due_date:       (fd.get('next_due_date') as string) || null,
      is_active:           true,
    })
    setSaving(false)
    if (result.error) { setError(result.error); return }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overflow-y-auto">
      <div className="bg-card-themed rounded-2xl shadow-dark-lg w-full max-w-lg p-6 my-4">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Edit Schedule</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        {error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-4"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Task Name <span className="text-red-500">*</span></label>
            <input name="name" type="text" required defaultValue={schedule.name} className="input" />
          </div>

          <div>
            <label className="label">Schedule Type</label>
            <div className="flex gap-2">
              {(['routine', 'seasonal'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setScheduleType(t)}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize',
                    scheduleType === t
                      ? 'border-transparent text-white'
                      : 'bg-canvas-themed border-themed text-secondary-themed'
                  )}
                  style={scheduleType === t ? { background: 'var(--accent-gold)', color: '#0a1628' } : undefined}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {scheduleType === 'routine' && (
            <div>
              <label className="label">Frequency</label>
              <select name="frequency" className="input" defaultValue={schedule.frequency ?? ''}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="semi_annual">Semi-annual</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          )}

          {scheduleType === 'seasonal' && (
            <div>
              <label className="label">Month Due</label>
              <select name="month_due" className="input" defaultValue={schedule.month_due ?? ''}>
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Next Due Date</label>
            <input name="next_due_date" type="date" className="input"
                   defaultValue={schedule.next_due_date ?? ''} />
          </div>

          <div>
            <label className="label">Assigned Vendor</label>
            <select name="assigned_vendor_id" className="input"
                    defaultValue={schedule.assigned_vendor_id ?? ''}>
              <option value="">No vendor assigned</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Estimated Cost</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-themed text-sm">$</span>
              <input name="estimated_cost" type="number" min="0" step="0.01"
                     className="input pl-7" defaultValue={schedule.estimated_cost ?? ''} />
            </div>
          </div>

          <div>
            <label className="label">Instructions</label>
            <textarea name="instructions" rows={2} className="input resize-none"
                      defaultValue={schedule.instructions ?? ''} />
          </div>

          <div
            className="flex items-start gap-3 p-3 rounded-xl cursor-pointer select-none"
            style={{
              background: autoCreate ? 'var(--accent-green-dim)' : 'var(--bg-canvas)',
              border: `1px solid ${autoCreate ? 'rgba(47,217,140,0.3)' : 'var(--border)'}`,
            }}
            onClick={() => setAutoCreate((v) => !v)}
          >
            <div className="flex-shrink-0 mt-0.5">
              {autoCreate
                ? <ToggleRight className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
                : <ToggleLeft className="w-5 h-5 text-muted-themed" />}
            </div>
            <div>
              <p className="text-sm font-medium text-primary-themed">Automatically create work orders</p>
              <p className="text-xs text-muted-themed mt-0.5">
                {autoCreate ? 'WO auto-created 7 days before due date.' : 'Manual WO creation only.'}
              </p>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

**Replace the `SchedulesSection` function** with this updated version that
adds an "Add Schedule" button, edit/delete per row, and shows vendors:

```typescript
function SchedulesSection({
  schedules,
  properties,
  vendors,
}: {
  schedules: ScheduleRow[]
  properties: PropertyOption[]
  vendors: VendorOption[]
}) {
  const [open, setOpen]               = useState(true)
  const [showAdd, setShowAdd]         = useState(false)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [deletingId, setDeletingId]   = useState<string | null>(null)
  const [creating, startCreate]       = useTransition()
  const [creatingId, setCreatingId]   = useState<string | null>(null)

  const handleCreateWO = (scheduleId: string) => {
    setCreatingId(scheduleId)
    startCreate(async () => {
      await createWorkOrderFromSchedule(scheduleId)
      setCreatingId(null)
    })
  }

  const handleDelete = async (scheduleId: string) => {
    setDeletingId(scheduleId)
    await deleteMaintenanceSchedule(scheduleId)
    setDeletingId(null)
  }

  const editingSchedule = schedules.find((s) => s.id === editingId) ?? null

  return (
    <div className="mt-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 flex-1 text-left group"
        >
          <span className="text-sm font-semibold text-secondary-themed group-hover:text-primary-themed transition-colors">
            Maintenance Schedules
          </span>
          <span className="badge badge-slate">{schedules.length}</span>
          <ChevronDown className={cn(
            'w-4 h-4 text-muted-themed transition-transform',
            open && 'rotate-180'
          )} />
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="btn-secondary text-xs py-1.5 px-3"
        >
          <Plus className="w-3 h-3" />
          Add Schedule
        </button>
      </div>
      <p className="text-xs text-muted-themed mb-3">
        Recurring tasks that generate work orders automatically or alert you when due
      </p>

      {open && (
        schedules.length === 0 ? (
          <div className="card text-center py-10">
            <CalendarDays className="w-8 h-8 text-muted-themed mx-auto mb-2" />
            <p className="text-sm font-medium text-secondary-themed mb-1">No maintenance schedules yet</p>
            <p className="text-xs text-muted-themed mb-3">
              Add recurring tasks like HVAC filters, gutter cleaning, or pool maintenance.
            </p>
            <button onClick={() => setShowAdd(true)} className="btn-primary mx-auto text-sm">
              <Plus className="w-3.5 h-3.5" />
              Add First Schedule
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-themed bg-card-themed">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed bg-canvas-themed">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Property</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Frequency</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Vendor</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Next Due</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Auto</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {schedules.map((s) => {
                  const property  = getJoined(s.properties)
                  const vendor    = getJoined(s.vendors)
                  const isOverdue = s.next_due_date && new Date(s.next_due_date) < new Date()
                  return (
                    <tr key={s.id} className="hover:bg-canvas-themed transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-medium text-primary-themed">{s.name}</span>
                        {s.instructions && (
                          <p className="text-xs text-muted-themed mt-0.5 truncate max-w-[200px]">{s.instructions}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">{property?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-secondary-themed">
                        {s.schedule_type === 'seasonal' && s.month_due
                          ? `${MONTHS[s.month_due - 1]} (seasonal)`
                          : s.frequency ? (FREQUENCY_LABELS[s.frequency] ?? s.frequency) : '—'}
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">{vendor?.name ?? '—'}</td>
                      <td className="px-4 py-3">
                        {s.next_due_date ? (
                          <span className={cn('flex items-center gap-1',
                            isOverdue ? 'font-medium' : 'text-secondary-themed'
                          )}
                          style={isOverdue ? { color: 'var(--accent-red)' } : undefined}>
                            {isOverdue && <AlertTriangle className="w-3 h-3" />}
                            {formatDate(s.next_due_date)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {s.auto_create_wo
                          ? <span className="badge badge-green">Auto</span>
                          : <span className="badge badge-slate">Manual</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleCreateWO(s.id)}
                            disabled={creating && creatingId === s.id}
                            className="btn-secondary text-xs py-1.5 px-2.5 whitespace-nowrap"
                            title="Manually create a work order now"
                          >
                            {creating && creatingId === s.id
                              ? <Clock className="w-3 h-3 animate-spin" />
                              : <Plus className="w-3 h-3" />}
                            WO
                          </button>
                          <button
                            onClick={() => setEditingId(s.id)}
                            className="btn-ghost p-1.5 text-muted-themed hover:text-primary-themed"
                            title="Edit schedule"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(s.id)}
                            disabled={deletingId === s.id}
                            className="btn-ghost p-1.5 hover:text-red-500 text-muted-themed"
                            title="Remove schedule"
                          >
                            {deletingId === s.id
                              ? <Clock className="w-3.5 h-3.5 animate-spin" />
                              : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {showAdd && (
        <AddScheduleModal
          properties={properties}
          vendors={vendors}
          onClose={() => setShowAdd(false)}
        />
      )}

      {editingSchedule && (
        <EditScheduleModal
          schedule={editingSchedule}
          vendors={vendors}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
```

**Update `ScheduleRow` interface** — The existing `ScheduleRow` interface in
the file needs to also expose `vendors`. Find the `ScheduleRow` interface and
add `vendors` to it:

```typescript
interface ScheduleRow {
  id: string
  name: string
  description: string | null
  instructions: string | null
  schedule_type: ScheduleType
  frequency: ScheduleFrequency | null
  month_due: number | null
  estimated_cost: number | null
  auto_create_wo: boolean
  next_due_date: string | null
  last_completed_date: string | null
  assigned_vendor_id: string | null
  property_id: string
  org_id: string
  properties: { id: string; name: string } | { id: string; name: string }[] | null
  vendors: { id: string; name: string } | { id: string; name: string }[] | null
}
```

**Update `MaintenanceBoard` props and call to `SchedulesSection`** — The
`MaintenanceBoard` component currently receives `schedules` but not used as
props for `SchedulesSection`. Update the call site in `MaintenanceBoard`'s
return JSX where `<SchedulesSection schedules={schedules} />` appears to
pass `properties` and `vendors` too:

```tsx
<SchedulesSection schedules={schedules} properties={properties} vendors={vendors} />
```

**Update the maintenance `page.tsx`** — The server component at
`app/(dashboard)/maintenance/page.tsx` fetches schedules. Update its
Supabase query to also join `vendors`:

```typescript
supabase
  .from('maintenance_schedules')
  .select(`
    id, name, description, instructions, schedule_type, frequency,
    month_due, estimated_cost, auto_create_wo, next_due_date,
    last_completed_date, assigned_vendor_id, property_id, org_id,
    properties ( id, name ),
    vendors ( id, name )
  `)
  .eq('org_id', membership.org_id)
  .eq('is_active', true)
  .order('next_due_date', { ascending: true, nullsFirst: false })
```

**Import `CalendarDays`** from lucide-react in `maintenance-board.tsx`
if not already imported.

**Import `MONTHS` is defined inside `AddScheduleModal`** — since it's also
used in `SchedulesSection`, move the `MONTHS` array to module scope
(outside any function), placing it alongside the other constants like
`FREQUENCY_LABELS`.

---

## 2 — Vendor Modal: Email + Phone Both Required

**File:** `app/(dashboard)/vendors/vendors-client.tsx`

Locate the `AddVendorForm` function (around line 172). Find the email and
phone input fields. They currently have no `required` attribute. Add
`required` to both:

```tsx
{/* BEFORE */}
<input id="vendor-email" name="email" type="email" className="input" placeholder="info@abcplumbing.com" />
...
<input id="vendor-phone" name="phone" type="tel" className="input" placeholder="+1 555-0100" />

{/* AFTER */}
<input id="vendor-email" name="email" type="email" required className="input" placeholder="info@abcplumbing.com" />
...
<input id="vendor-phone" name="phone" type="tel" required className="input" placeholder="+1 555-0100" />
```

Also add `*` required indicators to both labels:

```tsx
{/* BEFORE */}
<label htmlFor="vendor-email" className="label">Email</label>
<label htmlFor="vendor-phone" className="label">Phone</label>

{/* AFTER */}
<label htmlFor="vendor-email" className="label">Email <span className="text-red-500">*</span></label>
<label htmlFor="vendor-phone" className="label">Phone <span className="text-red-500">*</span></label>
```

---

## 3 — Crew Modal: Email + Phone Both Required

**File:** `app/(dashboard)/crew-manage/crew-manage-client.tsx`

Same process as done for the vendor in ##2

---

## 4 — Inventory: Unit Field Editable for Catalog Items

**File:** `app/(dashboard)/inventory/inventory-manager.tsx`

In the `AddItemModal`, the catalog tab currently passes unit as a hidden
field: `<input type="hidden" name="unit" value={selectedCatalog.default_unit} />`.
This means the PM cannot change the unit for a catalog item.

Replace the hidden unit field with a visible, editable input that
pre-fills with the catalog default. Locate the block that appears after
`selectedCatalog && (` and before the catalog list. Specifically, the
hidden inputs for catalog items include:

```tsx
{/* CURRENT — hidden unit field in catalog tab */}
{selectedCatalog && (
  <>
    <input type="hidden" name="catalog_item_id" value={selectedCatalog.id} />
    <input type="hidden" name="name" value={selectedCatalog.name} />
    <input type="hidden" name="category" value={selectedCatalog.category} />
    <input type="hidden" name="unit" value={selectedCatalog.default_unit} />
  </>
)}
```

Replace with:

```tsx
{selectedCatalog && (
  <>
    <input type="hidden" name="catalog_item_id" value={selectedCatalog.id} />
    <input type="hidden" name="name" value={selectedCatalog.name} />
    <input type="hidden" name="category" value={selectedCatalog.category} />
    {/* Unit is now editable, pre-filled from catalog default */}
  </>
)}
```

Then, in the area below the catalog list where the par level input
appears for catalog items (the `selectedCatalog && (` block near line 358):

```tsx
{/* CURRENT */}
{selectedCatalog && (
  <div>
    <label className="label">Par Level</label>
    <input name="par_level" type="number" min={1} defaultValue={1} className="input" />
  </div>
)}

{/* REPLACE WITH */}
{selectedCatalog && (
  <div className="grid grid-cols-2 gap-3">
    <div>
      <label className="label">Unit <span className="text-red-500">*</span></label>
      <input
        name="unit"
        type="text"
        required
        defaultValue={selectedCatalog.default_unit}
        className="input"
        placeholder="rolls, boxes, oz…"
      />
      <p className="text-xs text-muted-themed mt-1">
        Pre-filled from catalog. Edit if needed.
      </p>
    </div>
    <div>
      <label className="label">Par Level</label>
      <input name="par_level" type="number" min={0} step={0.5} defaultValue={1} className="input" />
    </div>
  </div>
)}
```

---

## 5 — Inventory: Par Level Supports 0.5 Increments

This change touches three places across two files.

### 5a — `app/(dashboard)/inventory/actions.ts`

**In `addInventoryItem`:** Change `parseInt` to `parseFloat`:
```typescript
// BEFORE
const par_level = parseInt(formData.get('par_level') as string, 10) || 1

// AFTER
const par_level = parseFloat(formData.get('par_level') as string) || 1
```

**In `updateParLevel`:** The function currently accepts a `parLevel: number`
param and passes it directly. Ensure the function signature allows decimals
(it already does since `number` covers floats — no change needed to the type).
But confirm the DB call passes the value as-is without parseInt anywhere.

### 5b — `app/(dashboard)/inventory/inventory-manager.tsx`

**In `ParLevelEditor` (around line 87):**

Change `parseInt` to `parseFloat`, and add `step={0.5}` to the input:

```typescript
// BEFORE
const handleSave = () => {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 0) { setError('Invalid number'); return }
  ...
  const res = await updateParLevel(item.id, n)
}
...
<input type="number" min={0} value={value} ... />

// AFTER
const handleSave = () => {
  const n = parseFloat(value)
  if (isNaN(n) || n < 0) { setError('Invalid number'); return }
  ...
  const res = await updateParLevel(item.id, n)
}
...
<input type="number" min={0} step={0.5} value={value} ... />
```

**In the custom item `AddItemModal` form (around line 403):**

```tsx
{/* BEFORE */}
<input name="par_level" type="number" min={1} defaultValue={1} className="input" />

{/* AFTER */}
<input name="par_level" type="number" min={0} step={0.5} defaultValue={1} className="input" />
```

**Display rounding** — The inventory table currently displays par level as
a plain number. Since par levels can now be 2.5, 3.5 etc., ensure the
display doesn't show unnecessary decimals. Find where `item.par_level` is
rendered in the table and update to:

```typescript
// Find: {item.par_level}
// Replace with:
{Number.isInteger(item.par_level) ? item.par_level : item.par_level.toFixed(1)}
```

This applies to the `ParLevelEditor` display button, the table cell, and
anywhere else `par_level` is rendered as a number.

---

## Verification Checklist

- [ ] `npm run build` passes with zero TypeScript errors
- [ ] Maintenance page shows "Add Schedule" button above the schedules table
- [ ] Clicking "Add Schedule" opens the modal with routine/seasonal toggle
- [ ] Routine schedule: frequency dropdown visible; month dropdown hidden
- [ ] Seasonal schedule: month dropdown visible; frequency dropdown hidden
- [ ] "Automatically create work orders" toggle shows green when on, explains behavior
- [ ] Saving a schedule adds it to the table immediately (revalidatePath)
- [ ] Pencil icon opens edit modal pre-filled with existing schedule data
- [ ] Trash icon soft-deletes the schedule (removes from list)
- [ ] Empty state shows when no schedules exist, with "Add First Schedule" CTA
- [ ] Vendor modal: form will not submit without both email and phone
- [ ] Crew modal: form will not submit if both email AND phone are blank
- [ ] Crew modal: submits successfully with only email or only phone
- [ ] Inventory catalog tab: unit field is visible and pre-filled but editable
- [ ] Inventory: par level input has step=0.5, accepts 2.5, 3.5 etc.
- [ ] Existing whole-number par levels display without decimal (show "3" not "3.0")
- [ ] Half-unit par levels display with one decimal (show "2.5" not "2.50")

---

## Notes

- Do NOT modify the existing `createWorkOrderFromSchedule` action — it is
  working and handles WO creation from schedules correctly.
- The `auto_create_wo` flag is already wired to the Inngest `dailyMaintenanceCheck`
  function which checks for it. Schedules with `auto_create_wo = true` and a
  valid `next_due_date` will automatically generate work orders 7 days before due.
- The soft-delete approach for schedules (`is_active = false`) is intentional —
  preserves history for any linked work orders.
- The `par_level` column in the database is `numeric(10,2)` which already supports
  decimal values. No migration needed.
- The `unit` column on `inventory_items` is already `text`. The catalog
  `default_unit` is a suggestion only — allowing PM override is purely a UI change.
