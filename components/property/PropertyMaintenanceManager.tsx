'use client'

import { useState, useTransition } from 'react'
import {
  updateMaintenanceScheduleItem,
  duplicateMaintenanceScheduleItem,
  removeMaintenanceScheduleItem,
  addCatalogItemToProperty,
  addCustomMaintenanceItem,
} from '@/app/(dashboard)/maintenance/actions'
import type {
  MaintenanceSchedule,
  MaintenanceCatalogItem,
  MaintenanceCatalogCategory,
  ScheduleFrequency,
} from '@/types/database'
import {
  RECURRENCE_LABELS,
  MONTH_NAMES,
  CATALOG_CATEGORY_LABELS,
} from '@/types/database'
import { Pencil, Copy, Trash2, Plus, BookOpen, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Dialog } from '@/components/ui/Dialog'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

// ── Due date badge ────────────────────────────────────────────────────────────

function DueBadge({
  nextDueDate,
  activeFromMonth,
  activeToMonth,
}: {
  nextDueDate:     string | null
  activeFromMonth: number | null
  activeToMonth:   number | null
}) {
  if (activeFromMonth != null && activeToMonth != null) {
    const month = new Date().getMonth() + 1
    const inWindow = activeFromMonth <= activeToMonth
      ? month >= activeFromMonth && month <= activeToMonth
      : month >= activeFromMonth || month <= activeToMonth

    if (!inWindow) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full text-muted-themed"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
          Off Season
        </span>
      )
    }
  }

  if (!nextDueDate) {
    return <span className="text-xs text-muted-themed">No date set</span>
  }

  const today    = new Date()
  today.setHours(0, 0, 0, 0)
  const due      = new Date(nextDueDate)
  const diffDays = Math.ceil((due.getTime() - today.getTime()) / 86_400_000)

  if (diffDays < 0) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
        Overdue
      </span>
    )
  }
  if (diffDays <= 7) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
        Due in {diffDays}d
      </span>
    )
  }
  if (diffDays <= 30) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' }}>
        Due in {diffDays}d
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-themed">
      {due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
    </span>
  )
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({
  item,
  onClose,
  onSaved,
}: {
  item:    MaintenanceSchedule
  onClose: () => void
  onSaved: () => void
}) {
  const [name,            setName]            = useState(item.name)
  const [frequency,       setFrequency]       = useState<ScheduleFrequency>(item.frequency ?? 'annual')
  const [nextDueDate,     setNextDueDate]     = useState(item.next_due_date ?? '')
  const [seasonal,        setSeasonal]        = useState(item.active_from_month != null)
  const [activeFrom,      setActiveFrom]      = useState<number>(item.active_from_month ?? 1)
  const [activeTo,        setActiveTo]        = useState<number>(item.active_to_month ?? 12)
  const [notes,           setNotes]           = useState(item.instructions ?? '')
  const [saving,          setSaving]          = useState(false)
  const [error,           setError]           = useState<string | null>(null)

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)

    const result = await updateMaintenanceScheduleItem(item.id, {
      name:              name.trim(),
      frequency,
      next_due_date:     nextDueDate || null,
      active_from_month: seasonal ? activeFrom : null,
      active_to_month:   seasonal ? activeTo   : null,
      instructions:      notes.trim() || null,
    })

    setSaving(false)
    if (result.error) { setError(result.error); return }
    onSaved()
  }

  const monthOptions = MONTH_NAMES.slice(1).map((m, i) => ({ value: i + 1, label: m }))

  return (
    <Dialog open onClose={onClose} title="Edit Schedule Item" maxWidthClassName="max-w-md">
      {error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-4"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="edit-name" className="label">Name</label>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="edit-recurrence" className="label">Recurrence</label>
            <select id="edit-recurrence" value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)} className="input">
              {(Object.entries(RECURRENCE_LABELS) as [ScheduleFrequency, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="edit-next-due-date" className="label">Next Due Date</label>
            <Input id="edit-next-due-date" type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={seasonal} onChange={(e) => setSeasonal(e.target.checked)}
                   className="rounded" style={{ accentColor: 'var(--accent-gold)' }} />
            <span className="text-sm text-primary-themed">Seasonal item (restrict to specific months)</span>
          </label>
        </div>

        {seasonal && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="edit-active-from" className="label">Active From</label>
              <select id="edit-active-from" value={activeFrom} onChange={(e) => setActiveFrom(Number(e.target.value))} className="input">
                {monthOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="edit-active-to" className="label">Active To</label>
              <select id="edit-active-to" value={activeTo} onChange={(e) => setActiveTo(Number(e.target.value))} className="input">
                {monthOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="edit-notes" className="label">Notes / Instructions</label>
          <textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input resize-none" />
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <Button onClick={handleSave} disabled={saving} className="flex items-center gap-2">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save Changes'}
        </Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}

// ── Duplicate modal ───────────────────────────────────────────────────────────

function DuplicateModal({
  item,
  onClose,
  onSaved,
}: {
  item:    MaintenanceSchedule
  onClose: () => void
  onSaved: () => void
}) {
  const [date,   setDate]   = useState(new Date().toISOString().split('T')[0])
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  async function handleDuplicate() {
    if (!date) { setError('Date is required'); return }
    setSaving(true)
    const result = await duplicateMaintenanceScheduleItem(item.id, date)
    setSaving(false)
    if (result.error) { setError(result.error); return }
    onSaved()
  }

  return (
    <Dialog open onClose={onClose} title="Duplicate Item" maxWidthClassName="max-w-sm">
      <p className="text-sm text-muted-themed mb-4">
        Duplicating: <strong className="text-primary-themed">{item.name}</strong>
      </p>

      {error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-4"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {error}
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="duplicate-next-due-date" className="label">Next Due Date for Duplicate</label>
        <Input id="duplicate-next-due-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button onClick={handleDuplicate} disabled={saving} className="flex items-center gap-2">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Duplicating…</> : 'Duplicate'}
        </Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}

// ── Catalog modal ─────────────────────────────────────────────────────────────

function CatalogModal({
  propertyId,
  catalog,
  onClose,
  onSaved,
}: {
  propertyId: string
  catalog:    MaintenanceCatalogItem[]
  onClose:    () => void
  onSaved:    () => void
}) {
  const [selectedItem, setSelectedItem] = useState<MaintenanceCatalogItem | null>(null)
  const [recurrence,   setRecurrence]   = useState<ScheduleFrequency>('annual')
  const [nextDueDate,  setNextDueDate]  = useState(new Date().toISOString().split('T')[0])
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  const byCategory = catalog.reduce<Record<string, MaintenanceCatalogItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = []
    acc[item.category].push(item)
    return acc
  }, {})

  function selectItem(item: MaintenanceCatalogItem) {
    setSelectedItem(item)
    setRecurrence((item.suggested_recurrence as ScheduleFrequency) ?? 'annual')
  }

  async function handleAdd() {
    if (!selectedItem) return
    setSaving(true)
    setError(null)
    const result = await addCatalogItemToProperty(propertyId, selectedItem.id, nextDueDate, recurrence)
    setSaving(false)
    if (result.error) { setError(result.error); return }
    onSaved()
  }

  const categories = Object.keys(byCategory) as MaintenanceCatalogCategory[]

  return (
    <Dialog open onClose={onClose} title="Add from Catalog" maxWidthClassName="max-w-md">
      {!selectedItem ? (
        <div className="max-h-[60vh] overflow-y-auto space-y-4">
          {categories.map((cat) => (
            <div key={cat}>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-themed mb-1.5 px-1">
                {CATALOG_CATEGORY_LABELS[cat] ?? cat}
              </p>
              <div className="space-y-1">
                {byCategory[cat].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => selectItem(item)}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-themed text-left hover:bg-raised-themed transition-colors"
                  >
                    <span className="text-sm text-primary-themed">{item.name}</span>
                    {item.suggested_recurrence && (
                      <span className="text-xs text-muted-themed ml-2 shrink-0">
                        {RECURRENCE_LABELS[item.suggested_recurrence as ScheduleFrequency]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            onClick={() => setSelectedItem(null)}
            className="text-sm text-muted-themed hover:text-secondary-themed"
          >
            ← Back to catalog
          </button>

          <div className="rounded-xl border border-themed p-3" style={{ background: 'var(--bg-raised)' }}>
            <p className="text-sm font-semibold text-primary-themed">{selectedItem.name}</p>
            {selectedItem.description && (
              <p className="text-xs text-muted-themed mt-1">{selectedItem.description}</p>
            )}
          </div>

          {error && (
            <div className="text-sm rounded-lg px-3 py-2"
                 style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="catalog-recurrence" className="label">Recurrence</label>
              <select id="catalog-recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value as ScheduleFrequency)} className="input">
                {(Object.entries(RECURRENCE_LABELS) as [ScheduleFrequency, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="catalog-next-due-date" className="label">Next Due Date</label>
              <Input id="catalog-next-due-date" type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={handleAdd} disabled={saving} className="flex items-center gap-2">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add to Property'}
            </Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

// ── Custom item modal ─────────────────────────────────────────────────────────

function CustomItemModal({
  propertyId,
  onClose,
  onSaved,
}: {
  propertyId: string
  onClose:    () => void
  onSaved:    () => void
}) {
  const [name,       setName]       = useState('')
  const [frequency,  setFrequency]  = useState<ScheduleFrequency>('annual')
  const [dueDate,    setDueDate]    = useState(new Date().toISOString().split('T')[0])
  const [seasonal,   setSeasonal]   = useState(false)
  const [activeFrom, setActiveFrom] = useState(1)
  const [activeTo,   setActiveTo]   = useState(12)
  const [notes,      setNotes]      = useState('')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  async function handleAdd() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)

    const result = await addCustomMaintenanceItem(propertyId, {
      name:              name.trim(),
      frequency,
      next_due_date:     dueDate,
      active_from_month: seasonal ? activeFrom : null,
      active_to_month:   seasonal ? activeTo   : null,
      instructions:      notes.trim() || null,
    })

    setSaving(false)
    if (result.error) { setError(result.error); return }
    onSaved()
  }

  const monthOptions = MONTH_NAMES.slice(1).map((m, i) => ({ value: i + 1, label: m }))

  return (
    <Dialog open onClose={onClose} title="Add Custom Item" maxWidthClassName="max-w-md">
      {error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-4"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="custom-name" className="label">Name <span className="text-red-500">*</span></label>
          <Input id="custom-name" value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. Boat dock winterization" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="custom-recurrence" className="label">Recurrence</label>
            <select id="custom-recurrence" value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)} className="input">
              {(Object.entries(RECURRENCE_LABELS) as [ScheduleFrequency, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="custom-next-due-date" className="label">Next Due Date</label>
            <Input id="custom-next-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={seasonal} onChange={(e) => setSeasonal(e.target.checked)}
                 className="rounded" style={{ accentColor: 'var(--accent-gold)' }} />
          <span className="text-sm text-primary-themed">Seasonal (restrict to specific months)</span>
        </label>

        {seasonal && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="custom-active-from" className="label">Active From</label>
              <select id="custom-active-from" value={activeFrom} onChange={(e) => setActiveFrom(Number(e.target.value))} className="input">
                {monthOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="custom-active-to" className="label">Active To</label>
              <select id="custom-active-to" value={activeTo} onChange={(e) => setActiveTo(Number(e.target.value))} className="input">
                {monthOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="custom-notes" className="label">Notes</label>
          <textarea id="custom-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input resize-none" />
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <Button onClick={handleAdd} disabled={saving} className="flex items-center gap-2">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add Item'}
        </Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type Modal =
  | { type: 'edit';      item: MaintenanceSchedule }
  | { type: 'duplicate'; item: MaintenanceSchedule }
  | { type: 'catalog' }
  | { type: 'custom' }
  | null

export function PropertyMaintenanceManager({
  propertyId,
  initialSchedules,
  catalog,
}: {
  propertyId:       string
  initialSchedules: MaintenanceSchedule[]
  catalog:          MaintenanceCatalogItem[]
}) {
  const router      = useRouter()
  const [schedules, setSchedules] = useState(initialSchedules)
  const [modal,     setModal]     = useState<Modal>(null)
  const [removing,  startRemove]  = useTransition()
  const [removingId, setRemovingId] = useState<string | null>(null)

  function refresh() {
    router.refresh()
    setModal(null)
  }

  function handleRemove(item: MaintenanceSchedule) {
    if (!confirm(`Remove "${item.name}" from this property's schedule?`)) return
    setRemovingId(item.id)
    startRemove(async () => {
      await removeMaintenanceScheduleItem(item.id, propertyId)
      setSchedules((prev) => prev.filter((s) => s.id !== item.id))
      setRemovingId(null)
    })
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-primary-themed">Maintenance Schedule</h3>
          {schedules.length > 0 && (
            <Badge tone="slate">{schedules.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setModal({ type: 'catalog' })}
            className="text-sm flex items-center gap-1.5"
          >
            <BookOpen className="w-3.5 h-3.5" /> From Catalog
          </Button>
          <Button
            onClick={() => setModal({ type: 'custom' })}
            className="text-sm flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Custom
          </Button>
        </div>
      </div>

      {/* Item list */}
      {schedules.length === 0 ? (
        <p className="text-sm text-muted-themed text-center py-8">
          No maintenance items yet. Add from catalog or create a custom item.
        </p>
      ) : (
        <div className="divide-y divide-themed">
          {schedules.map((s) => (
            <div key={s.id} className="py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-primary-themed">{s.name}</span>
                  <Badge tone="slate" className="text-xs">
                    {RECURRENCE_LABELS[s.frequency ?? 'annual']}
                  </Badge>
                  {s.active_from_month != null && s.active_to_month != null && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }}>
                      {MONTH_NAMES[s.active_from_month]}–{MONTH_NAMES[s.active_to_month]}
                    </span>
                  )}
                </div>
                <div className="mt-1">
                  <DueBadge
                    nextDueDate={s.next_due_date}
                    activeFromMonth={s.active_from_month}
                    activeToMonth={s.active_to_month}
                  />
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  onClick={() => setModal({ type: 'edit', item: s })}
                  className="p-1.5"
                  title="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setModal({ type: 'duplicate', item: s })}
                  className="p-1.5"
                  title="Duplicate"
                >
                  <Copy className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => handleRemove(s)}
                  disabled={removing && removingId === s.id}
                  className="p-1.5 text-muted-themed hover:text-red-500"
                  title="Remove"
                >
                  {removing && removingId === s.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />
                  }
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {modal?.type === 'edit' && (
        <EditModal
          item={modal.item}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal?.type === 'duplicate' && (
        <DuplicateModal
          item={modal.item}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal?.type === 'catalog' && (
        <CatalogModal
          propertyId={propertyId}
          catalog={catalog}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal?.type === 'custom' && (
        <CustomItemModal
          propertyId={propertyId}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
    </>
  )
}
