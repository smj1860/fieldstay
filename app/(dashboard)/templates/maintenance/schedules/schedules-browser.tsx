'use client'

import { useMemo, useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'
import { createMaintenanceSchedule, updateMaintenanceSchedule, deleteMaintenanceSchedule } from '@/app/(dashboard)/maintenance/actions'
import type { ScheduleFrequency, ScheduleType } from '@/types/database'

const FREQUENCY_LABELS: Partial<Record<ScheduleFrequency, string>> = {
  weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', semi_annual: 'Semi-annual', annual: 'Annual',
}

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' },
  { value: 'semi_annual', label: 'Semi-annual' }, { value: 'annual', label: 'Annual' },
]

interface Property { id: string; name: string }
interface Vendor { id: string; name: string; specialty: string }

interface ScheduleRow {
  id:                 string
  property_id:        string
  name:               string
  description:        string | null
  schedule_type:      ScheduleType
  frequency:          ScheduleFrequency | null
  month_due:          number | null
  next_due_date:      string | null
  estimated_cost:     number | null
  auto_create_wo:     boolean
  assigned_vendor_id: string | null
  instructions:       string | null
  template_id:        string | null
}

function labelForProperty(schedules: ScheduleRow[], templateNameById: Record<string, string>): { label: string; tone: 'green' | 'amber' | 'slate' } {
  if (schedules.length === 0) return { label: 'No schedules yet', tone: 'slate' }
  const templateIds = new Set(schedules.map((s) => s.template_id))
  if (templateIds.size === 1) {
    const [only] = templateIds
    if (only) return { label: templateNameById[only] ?? 'Unknown template', tone: 'green' }
  }
  return { label: 'Mixed', tone: 'amber' }
}

export function SchedulesBrowser({
  properties,
  schedules,
  templateNameById,
  vendors,
  canManage,
}: Readonly<{
  properties:       Property[]
  schedules:        ScheduleRow[]
  templateNameById: Record<string, string>
  vendors:          Vendor[]
  canManage:        boolean
}>) {
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null)
  const [liveSchedules, setLiveSchedules] = useState<ScheduleRow[]>(schedules)

  const schedulesByProperty = useMemo(() => {
    const map: Record<string, ScheduleRow[]> = {}
    for (const s of liveSchedules) {
      const bucket = map[s.property_id] ?? []
      bucket.push(s)
      map[s.property_id] = bucket
    }
    return map
  }, [liveSchedules])

  const editingProperty = properties.find((p) => p.id === editingPropertyId) ?? null

  if (properties.length === 0) {
    return <p className="text-sm text-muted-themed">No active properties yet.</p>
  }

  return (
    <>
      <Card className="divide-y divide-themed p-0 overflow-hidden">
        {properties.map((property) => {
          const propertySchedules = schedulesByProperty[property.id] ?? []
          const { label, tone } = labelForProperty(propertySchedules, templateNameById)
          return (
            <button
              key={property.id}
              type="button"
              onClick={() => setEditingPropertyId(property.id)}
              className="w-full flex items-center justify-between gap-4 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-primary-themed">{property.name}</p>
                <p className="text-xs text-muted-themed mt-0.5">{propertySchedules.length} schedule{propertySchedules.length !== 1 ? 's' : ''}</p>
              </div>
              <Badge tone={tone}>{label}</Badge>
            </button>
          )
        })}
      </Card>

      {editingProperty && (
        <PropertySchedulesEditor
          property={editingProperty}
          schedules={schedulesByProperty[editingProperty.id] ?? []}
          vendors={vendors}
          canManage={canManage}
          onClose={() => setEditingPropertyId(null)}
          onSchedulesChange={(next) => {
            setLiveSchedules((prev) => [
              ...prev.filter((s) => s.property_id !== editingProperty.id),
              ...next,
            ])
          }}
        />
      )}
    </>
  )
}

function PropertySchedulesEditor({
  property,
  schedules,
  vendors,
  canManage,
  onClose,
  onSchedulesChange,
}: Readonly<{
  property:          Property
  schedules:         ScheduleRow[]
  vendors:           Vendor[]
  canManage:         boolean
  onClose:           () => void
  onSchedulesChange: (schedules: ScheduleRow[]) => void
}>) {
  const [rows, setRows] = useState<ScheduleRow[]>(schedules)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFrequency, setNewFrequency] = useState<ScheduleFrequency>('quarterly')
  const [adding, startAdd] = useTransition()

  const updateRow = (id: string, patch: Partial<ScheduleRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const saveRow = (row: ScheduleRow) => {
    setSavingId(row.id)
    startSave(async () => {
      setError(null)
      const result = await updateMaintenanceSchedule(row.id, {
        name:               row.name,
        description:        row.description,
        schedule_type:      row.schedule_type,
        frequency:          row.frequency,
        month_due:          row.month_due,
        next_due_date:      row.next_due_date,
        estimated_cost:     row.estimated_cost,
        assigned_vendor_id: row.assigned_vendor_id,
        auto_create_wo:     row.auto_create_wo,
        instructions:       row.instructions,
      })
      setSavingId(null)
      if (result.error) { setError(result.error); return }
      const next = rows.map((r) => (r.id === row.id ? row : r))
      setRows(next)
      onSchedulesChange(next)
    })
  }

  const removeRow = (row: ScheduleRow) => {
    setDeletingId(row.id)
    startSave(async () => {
      const result = await deleteMaintenanceSchedule(row.id)
      setDeletingId(null)
      if (result?.error) { setError(result.error); return }
      const next = rows.filter((r) => r.id !== row.id)
      setRows(next)
      onSchedulesChange(next)
    })
  }

  const addSchedule = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    startAdd(async () => {
      setError(null)
      const result = await createMaintenanceSchedule({
        property_id:        property.id,
        name:               trimmed,
        description:        null,
        schedule_type:      'routine',
        frequency:          newFrequency,
        month_due:          null,
        next_due_date:      null,
        estimated_cost:     null,
        assigned_vendor_id: null,
        auto_create_wo:     true,
        instructions:       null,
      })
      if (result.error) { setError(result.error); return }
      // createMaintenanceSchedule doesn't return the created row's id — the
      // simplest correct way to reflect it here is to close and let the
      // page's next load (revalidatePath already fires inside it) show
      // the real state, rather than guessing at what got inserted.
      onClose()
    })
  }

  return (
    <Dialog open onClose={onClose} title={property.name} maxWidthClassName="max-w-2xl" mobileSheet>
      <div className="space-y-4">
        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        <div className="space-y-3 max-h-96 overflow-y-auto">
          {rows.map((row) => (
            <div key={row.id} className="border border-themed rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-primary-themed truncate">{row.name}</span>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => removeRow(row)}
                    disabled={saving && deletingId === row.id}
                    className="text-muted-themed hover:text-red-500 transition-colors p-1 flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {canManage ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <select
                      value={row.frequency ?? 'quarterly'}
                      onChange={(e) => updateRow(row.id, { frequency: e.target.value as ScheduleFrequency })}
                      className="input text-xs py-1"
                    >
                      {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    <input
                      type="date"
                      value={row.next_due_date ?? ''}
                      onChange={(e) => updateRow(row.id, { next_due_date: e.target.value || null })}
                      className="input text-xs py-1"
                    />
                    <select
                      value={row.assigned_vendor_id ?? ''}
                      onChange={(e) => updateRow(row.id, { assigned_vendor_id: e.target.value || null })}
                      className="input text-xs py-1 col-span-2 sm:col-span-1"
                    >
                      <option value="">No vendor</option>
                      {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <label htmlFor={`auto-create-wo-${row.id}`} className="flex items-center gap-1.5 text-xs text-secondary-themed">
                      <Checkbox
                        id={`auto-create-wo-${row.id}`}
                        checked={row.auto_create_wo}
                        onChange={(e) => updateRow(row.id, { auto_create_wo: e.target.checked })}
                      />
                      Auto-create WO
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      onClick={() => saveRow(row)}
                      disabled={saving && savingId === row.id}
                      className="text-xs py-1 px-2.5"
                    >
                      {saving && savingId === row.id ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-themed">
                  {row.frequency ? FREQUENCY_LABELS[row.frequency] ?? row.frequency : '—'}
                  {row.next_due_date && <> · Due {row.next_due_date}</>}
                  {row.auto_create_wo && <> · Auto-create WO</>}
                </p>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-sm text-muted-themed">No schedules on this property yet.</p>
          )}
        </div>

        {canManage && (
          showAddForm ? (
            <div className="border border-themed rounded-xl p-3 flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <label htmlFor={`new-schedule-${property.id}`} className="text-xs font-medium text-secondary-themed">
                  Schedule name <RequiredMark />
                </label>
                <Input
                  id={`new-schedule-${property.id}`}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addSchedule() }}
                  placeholder="e.g. HVAC Filter Change"
                  className="mt-1 text-sm"
                />
              </div>
              <select
                value={newFrequency}
                onChange={(e) => setNewFrequency(e.target.value as ScheduleFrequency)}
                className="input text-sm"
              >
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <Button onClick={addSchedule} disabled={adding || !newName.trim()} className="text-sm whitespace-nowrap">
                {adding ? 'Adding…' : 'Add'}
              </Button>
              <Button variant="ghost" onClick={() => setShowAddForm(false)} className="text-sm">Cancel</Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setShowAddForm(true)} className="text-sm inline-flex items-center gap-1.5 w-full justify-center border-dashed">
              <Plus className="w-4 h-4" /> Add Schedule
            </Button>
          )
        )}
      </div>
    </Dialog>
  )
}
