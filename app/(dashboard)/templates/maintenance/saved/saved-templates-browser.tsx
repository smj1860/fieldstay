'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2, AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  addMaintenanceTemplateItem, updateMaintenanceTemplateItem, removeMaintenanceTemplateItem,
} from '../actions'
import { updateMaintenanceTemplate, broadcastMaintenanceTemplate } from '@/app/(dashboard)/maintenance/actions'
import type { ScheduleFrequency, VendorSpecialty } from '@/types/database'

const FREQUENCY_LABELS: Partial<Record<ScheduleFrequency, string>> = {
  weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', semi_annual: 'Semi-annual', annual: 'Annual',
}

interface TemplateItemRow {
  id:                    string
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
  is_optional_flag:      string | null
  sort_order:            number
}

interface TemplateRow {
  id:            string
  name:          string
  description:   string | null
  isSystem:      boolean
  items:         TemplateItemRow[]
  propertyNames: string[]
}

interface Property { id: string; name: string }

export function SavedTemplatesBrowser({
  templates,
  allProperties,
  canManage,
}: Readonly<{ templates: TemplateRow[]; allProperties: Property[]; canManage: boolean }>) {
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null)
  const selected = templates.find((t) => t.id === selectedId) ?? null

  if (templates.length === 0) {
    return <p className="text-sm text-muted-themed">No templates yet — build one on the Create Template tab.</p>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="md:col-span-1 border border-themed rounded-xl overflow-hidden divide-y divide-themed">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => setSelectedId(template.id)}
            className="w-full text-left px-4 py-3 hover:bg-raised-themed transition-colors"
            style={template.id === selectedId ? { background: 'var(--accent-gold-dim)' } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-primary-themed">{template.name}</p>
              {template.isSystem && <Badge tone="blue" className="text-xs">FieldStay</Badge>}
            </div>
            <p className="text-xs text-muted-themed mt-0.5">
              {template.items.length} item{template.items.length !== 1 ? 's' : ''} · used by {template.propertyNames.length} propert{template.propertyNames.length === 1 ? 'y' : 'ies'}
            </p>
          </button>
        ))}
      </div>

      <div className="md:col-span-2">
        {selected && (
          <TemplateDetail
            key={selected.id}
            template={selected}
            allProperties={allProperties}
            canManage={canManage}
          />
        )}
      </div>
    </div>
  )
}

function TemplateDetail({
  template,
  allProperties,
  canManage,
}: Readonly<{ template: TemplateRow; allProperties: Property[]; canManage: boolean }>) {
  const editable = canManage && !template.isSystem

  const [name, setName] = useState(template.name)
  const [description, setDescription] = useState(template.description ?? '')
  const [savingDetails, startSaveDetails] = useTransition()
  const [detailsSaved, setDetailsSaved] = useState(false)

  const [items, setItems] = useState<TemplateItemRow[]>(template.items)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const [showAddForm, setShowAddForm] = useState(false)
  const [newItem, setNewItem] = useState({ name: '', schedule_frequency: 'quarterly' as ScheduleFrequency })

  const [showApplyDialog, setShowApplyDialog] = useState(false)
  const [applyPropertyIds, setApplyPropertyIds] = useState<string[]>([])
  const [applying, startApply] = useTransition()
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ created?: number; skipped?: number } | null>(null)

  const handleSaveDetails = () => {
    if (!editable) return
    startSaveDetails(async () => {
      setError(null)
      setDetailsSaved(false)
      const result = await updateMaintenanceTemplate(template.id, { name: name.trim(), description: description.trim() || null })
      if (result?.error) { setError(result.error); return }
      setDetailsSaved(true)
      setTimeout(() => setDetailsSaved(false), 2000)
    })
  }

  const handleFrequencyChange = (itemId: string, frequency: ScheduleFrequency) => {
    const previous = items.find((i) => i.id === itemId)?.schedule_frequency
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, schedule_frequency: frequency } : i)))
    startSave(async () => {
      const result = await updateMaintenanceTemplateItem(itemId, { schedule_frequency: frequency })
      if (result.error) {
        setError(result.error)
        if (previous) setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, schedule_frequency: previous } : i)))
      }
    })
  }

  const handleRemoveItem = (itemId: string) => {
    startSave(async () => {
      const result = await removeMaintenanceTemplateItem(itemId)
      if (result.error) { setError(result.error); return }
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    })
  }

  const handleAddItem = () => {
    const trimmed = newItem.name.trim()
    if (!trimmed) return
    startSave(async () => {
      setError(null)
      const result = await addMaintenanceTemplateItem(template.id, {
        name:                  trimmed,
        description:           null,
        schedule_frequency:    newItem.schedule_frequency,
        vendor_specialty_hint: null,
        estimated_cost:        null,
      })
      if (result.error || !result.item) {
        setError(result.error ?? 'Failed to add item.')
        return
      }
      setItems((prev) => [...prev, result.item!])
      setNewItem({ name: '', schedule_frequency: 'quarterly' })
      setShowAddForm(false)
    })
  }

  const toggleApplyProperty = (id: string) =>
    setApplyPropertyIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  const handleApply = () => {
    if (applyPropertyIds.length === 0) return
    startApply(async () => {
      setApplyError(null)
      const result = await broadcastMaintenanceTemplate(template.id, applyPropertyIds)
      if (result.error) { setApplyError(result.error); return }
      setApplyResult(result)
    })
  }

  const closeApplyDialog = () => {
    setShowApplyDialog(false)
    setApplyPropertyIds([])
    setApplyError(null)
    setApplyResult(null)
  }

  return (
    <Card className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          {editable ? (
            <>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="text-base font-semibold mb-1" />
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" className="text-sm" />
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="secondary"
                  onClick={handleSaveDetails}
                  disabled={savingDetails || !name.trim()}
                  className="text-xs py-1.5 px-3"
                >
                  {savingDetails ? 'Saving…' : detailsSaved ? 'Saved ✓' : 'Save Name & Description'}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-primary-themed">{template.name}</h3>
              {template.isSystem && (
                <Badge tone="blue" className="flex items-center gap-1" title="This is a read-only FieldStay template. Create your own template to customize it.">
                  <Lock className="w-3 h-3" /> Read-only
                </Badge>
              )}
            </div>
          )}
          {!editable && template.description && (
            <p className="text-xs text-muted-themed mt-1">{template.description}</p>
          )}
          <p className="text-xs text-muted-themed mt-2">
            {template.propertyNames.length === 0
              ? 'Not applied to any property yet'
              : `Used by: ${template.propertyNames.join(', ')}`}
          </p>
        </div>
        {canManage && (
          <Button variant="secondary" onClick={() => setShowApplyDialog(true)} className="text-sm whitespace-nowrap">
            Apply to Properties
          </Button>
        )}
      </div>

      <div className="border border-themed rounded-lg divide-y divide-themed">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 px-3 py-2">
            <span className="text-sm text-primary-themed flex-1 truncate">{item.name}</span>
            {item.is_optional_flag && (
              <Badge tone="amber" className="text-xs flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />{item.is_optional_flag}
              </Badge>
            )}
            {editable ? (
              <select
                value={item.schedule_frequency}
                onChange={(e) => handleFrequencyChange(item.id, e.target.value as ScheduleFrequency)}
                className="text-xs border border-themed rounded px-1.5 py-1 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
              >
                {(Object.entries(FREQUENCY_LABELS) as [ScheduleFrequency, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            ) : (
              <Badge tone="slate" className="text-xs">{FREQUENCY_LABELS[item.schedule_frequency] ?? item.schedule_frequency}</Badge>
            )}
            {editable && (
              <button
                type="button"
                onClick={() => handleRemoveItem(item.id)}
                disabled={saving}
                className="text-muted-themed hover:text-[var(--accent-red)] transition-colors p-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-sm text-muted-themed px-3 py-3">No items in this template.</p>
        )}
      </div>

      {editable && (
        showAddForm ? (
          <div className="border border-themed rounded-xl p-3 flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <label htmlFor={`new-mtx-item-${template.id}`} className="text-xs font-medium text-secondary-themed">Item name</label>
              <input
                id={`new-mtx-item-${template.id}`}
                value={newItem.name}
                onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddItem() }}
                className="input mt-1 w-full text-sm"
              />
            </div>
            <select
              value={newItem.schedule_frequency}
              onChange={(e) => setNewItem((p) => ({ ...p, schedule_frequency: e.target.value as ScheduleFrequency }))}
              className="input text-sm"
            >
              {(Object.entries(FREQUENCY_LABELS) as [ScheduleFrequency, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <Button onClick={handleAddItem} disabled={saving || !newItem.name.trim()} className="text-sm whitespace-nowrap">Add</Button>
            <Button variant="ghost" onClick={() => setShowAddForm(false)} className="text-sm">Cancel</Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setShowAddForm(true)} className="text-sm inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Add Item
          </Button>
        )
      )}

      <Dialog open={showApplyDialog} onClose={closeApplyDialog} title="Apply Template" maxWidthClassName="max-w-sm">
        {applyError && <InlineAlert tone="error" className="mb-3">{applyError}</InlineAlert>}
        {applyResult ? (
          <div className="space-y-4">
            <InlineAlert tone="success" className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Created {applyResult.created ?? 0} schedule{(applyResult.created ?? 0) !== 1 ? 's' : ''}
                {(applyResult.skipped ?? 0) > 0 && <> · {applyResult.skipped} skipped (already existed)</>}
              </span>
            </InlineAlert>
            <Button onClick={closeApplyDialog} className="w-full">Done</Button>
          </div>
        ) : allProperties.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-themed">No active properties to apply this template to.</p>
            <Button onClick={closeApplyDialog} className="w-full">Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="max-h-56 overflow-y-auto border border-themed rounded-lg divide-y divide-themed">
              {allProperties.map((property) => (
                <label key={property.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-raised-themed transition-colors">
                  <Checkbox
                    checked={applyPropertyIds.includes(property.id)}
                    onChange={() => toggleApplyProperty(property.id)}
                  />
                  <span className="text-sm text-primary-themed">{property.name}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleApply} disabled={applying || applyPropertyIds.length === 0} className="flex-1">
                {applying ? 'Applying…' : `Apply to ${applyPropertyIds.length || ''} propert${applyPropertyIds.length === 1 ? 'y' : 'ies'}`}
              </Button>
              <Button variant="ghost" onClick={closeApplyDialog}>Cancel</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  )
}
