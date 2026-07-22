'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  addTemplateItem, removeTemplateItem, updateTemplateItemBrand, applyTemplateToProperties,
} from '@/app/(dashboard)/inventory/actions'
import type { InventoryCategory } from '@/types/database'

interface TemplateItemRow {
  id:              string
  name:            string
  category:        InventoryCategory
  unit:            string
  par_level:       number
  notes:           string | null
  preferred_brand: string | null
}

interface TemplateRow {
  id:            string
  name:          string
  description:   string | null
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
            <p className="text-sm font-medium text-primary-themed">{template.name}</p>
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
  const [items, setItems] = useState<TemplateItemRow[]>(template.items)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const [showAddForm, setShowAddForm] = useState(false)
  const [newItem, setNewItem] = useState({ name: '', category: 'other' as InventoryCategory, unit: 'units' })

  const [showApplyDialog, setShowApplyDialog] = useState(false)
  const [applyPropertyIds, setApplyPropertyIds] = useState<string[]>([])
  const [applying, startApply] = useTransition()
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ applied: number } | null>(null)

  const handleBrandChange = (itemId: string, brand: string) => {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, preferred_brand: brand || null } : i)))
    startSave(async () => {
      const result = await updateTemplateItemBrand(itemId, brand || null)
      if (result.error) setError(result.error)
    })
  }

  const handleRemoveItem = (itemId: string) => {
    startSave(async () => {
      const result = await removeTemplateItem(itemId)
      if (result.error) { setError(result.error); return }
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    })
  }

  const handleAddItem = () => {
    const trimmed = newItem.name.trim()
    if (!trimmed) return
    startSave(async () => {
      setError(null)
      const result = await addTemplateItem(template.id, {
        name:      trimmed,
        category:  newItem.category,
        unit:      newItem.unit.trim() || 'units',
        par_level: 1,
      })
      if (result.error || !result.item) {
        setError(result.error ?? 'Failed to add item.')
        return
      }
      setItems((prev) => [...prev, { ...result.item!, category: result.item!.category as InventoryCategory }])
      setNewItem({ name: '', category: 'other', unit: 'units' })
      setShowAddForm(false)
    })
  }

  const toggleApplyProperty = (id: string) =>
    setApplyPropertyIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  const handleApply = () => {
    if (applyPropertyIds.length === 0) return
    startApply(async () => {
      setApplyError(null)
      const result = await applyTemplateToProperties(template.id, applyPropertyIds)
      if (result.error) { setApplyError(result.error); return }
      setApplyResult({ applied: result.applied })
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
        <div>
          <h3 className="text-base font-semibold text-primary-themed">{template.name}</h3>
          <p className="text-xs text-muted-themed mt-1">
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
            <span className="text-sm text-primary-themed flex-1">{item.name}</span>
            <span className="text-xs text-muted-themed">{INVENTORY_CATEGORY_LABELS[item.category] ?? item.category}</span>
            {canManage ? (
              <input
                value={item.preferred_brand ?? ''}
                onChange={(e) => handleBrandChange(item.id, e.target.value)}
                placeholder="Brand (optional)"
                className="text-xs border border-themed rounded px-2 py-0.5 bg-transparent text-primary-themed placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)] w-36"
              />
            ) : (
              item.preferred_brand && <span className="text-xs text-muted-themed">{item.preferred_brand}</span>
            )}
            {canManage && (
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

      {canManage && (
        showAddForm ? (
          <div className="border border-themed rounded-xl p-3 flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <label htmlFor={`new-item-name-${template.id}`} className="text-xs font-medium text-secondary-themed">Item name</label>
              <input
                id={`new-item-name-${template.id}`}
                value={newItem.name}
                onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddItem() }}
                className="input mt-1 w-full text-sm"
              />
            </div>
            <select
              value={newItem.category}
              onChange={(e) => setNewItem((p) => ({ ...p, category: e.target.value as InventoryCategory }))}
              className="input text-sm"
            >
              {(Object.entries(INVENTORY_CATEGORY_LABELS) as [InventoryCategory, string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <input
              value={newItem.unit}
              onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
              placeholder="units"
              className="input text-sm w-24"
            />
            <Button onClick={handleAddItem} disabled={saving || !newItem.name.trim()} className="text-sm whitespace-nowrap">
              Add
            </Button>
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
            <InlineAlert tone="success">
              Applied — {applyResult.applied} item{applyResult.applied !== 1 ? 's' : ''} added across selected properties.
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
                  <Checkbox checked={applyPropertyIds.includes(property.id)} onChange={() => toggleApplyProperty(property.id)} />
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
