'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { createCatalogItem, updateCatalogItem, deleteCatalogItem } from '../actions'
import type { InventoryCategory, ParMode, ParSmartGroup } from '@/types/database'
import { PAR_SMART_GROUPS, resolvePar } from '@/lib/inventory/par-engine'

// Sample property used to preview a smart-config formula — same fixed
// inputs used by the admin catalog/template editors.
const PREVIEW_PROPERTY = { bathrooms: 2, bedrooms: 3, max_guests: 6, avg_stay_length: 3 }

interface CatalogItemRow {
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
  par_mode:     ParMode
  smart_group:  ParSmartGroup | null
  base_qty:     number
}

function ParModeBadge({ par_mode, smart_group }: Readonly<{ par_mode: ParMode; smart_group: ParSmartGroup | null }>) {
  if (par_mode === 'static') return <Badge tone="slate">Static</Badge>
  return <Badge tone="gold">Smart{smart_group ? ` · ${PAR_SMART_GROUPS[smart_group].label.split(' (')[0]}` : ''}</Badge>
}

function ParConfigControls({
  item,
  onChange,
}: Readonly<{
  item:     Pick<CatalogItemRow, 'par_mode' | 'smart_group' | 'base_qty'>
  onChange: (patch: Partial<Pick<CatalogItemRow, 'par_mode' | 'smart_group' | 'base_qty'>>) => void
}>) {
  const preview = item.smart_group
    ? resolvePar(
        { par_mode: 'smart', smart_group: item.smart_group, base_qty: item.base_qty, par_level: 1, auto_adjust: false },
        PREVIEW_PROPERTY,
        null
      ).par
    : null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <select
          value={item.par_mode}
          onChange={(e) => {
            const par_mode = e.target.value as ParMode
            onChange(par_mode === 'smart' ? { par_mode, smart_group: item.smart_group ?? 'guest_consumable' } : { par_mode, smart_group: null })
          }}
          className="text-xs border border-themed rounded px-1.5 py-1 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
          aria-label="Par mode"
        >
          <option value="static">Static</option>
          <option value="smart">Smart</option>
        </select>
        {item.par_mode === 'smart' && (
          <>
            <select
              value={item.smart_group ?? ''}
              onChange={(e) => onChange({ smart_group: e.target.value as ParSmartGroup })}
              className="text-xs border border-themed rounded px-1.5 py-1 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
              aria-label="Smart group"
            >
              {Object.entries(PAR_SMART_GROUPS).map(([key, spec]) => (
                <option key={key} value={key}>{spec.label}</option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              step="any"
              value={item.base_qty}
              onChange={(e) => onChange({ base_qty: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 1 })}
              className="w-16 text-xs border border-themed rounded px-1.5 py-1 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
              aria-label="Base quantity"
            />
          </>
        )}
      </div>
      {item.par_mode === 'smart' && preview !== null && (
        <p className="text-xs text-muted-themed">Preview (2 ba / 3 br / 6 guests): <strong>{preview}</strong></p>
      )}
    </div>
  )
}

const CATEGORY_ENTRIES = Object.entries(INVENTORY_CATEGORY_LABELS) as [InventoryCategory, string][]

function groupByCategory(items: CatalogItemRow[]): Array<[InventoryCategory, CatalogItemRow[]]> {
  const groups = new Map<InventoryCategory, CatalogItemRow[]>()
  for (const item of items) {
    const bucket = groups.get(item.category) ?? []
    bucket.push(item)
    groups.set(item.category, bucket)
  }
  return CATEGORY_ENTRIES
    .map(([category]) => [category, groups.get(category) ?? []] as [InventoryCategory, CatalogItemRow[]])
    .filter(([, items]) => items.length > 0)
}

export function MasterListEditor({
  initialItems,
  canManage,
}: Readonly<{ initialItems: CatalogItemRow[]; canManage: boolean }>) {
  const [items, setItems] = useState<CatalogItemRow[]>(initialItems)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<InventoryCategory>('other')
  const [newUnit, setNewUnit] = useState('units')
  const [newParMode, setNewParMode] = useState<ParMode>('static')
  const [newSmartGroup, setNewSmartGroup] = useState<ParSmartGroup | null>(null)
  const [newBaseQty, setNewBaseQty] = useState(1)

  const replaceItem = (id: string, patch: Partial<CatalogItemRow>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const handleFieldChange = (item: CatalogItemRow, patch: Partial<CatalogItemRow>) => {
    replaceItem(item.id, patch)
    startSave(async () => {
      const result = await updateCatalogItem(item.id, patch)
      if (result.error) {
        setError(result.error)
        replaceItem(item.id, item)
      }
    })
  }

  const handleDelete = (id: string) => {
    startSave(async () => {
      const result = await deleteCatalogItem(id)
      if (result.error) { setError(result.error); return }
      setItems((prev) => prev.filter((item) => item.id !== id))
    })
  }

  const handleAdd = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    startSave(async () => {
      const parConfig = { par_mode: newParMode, smart_group: newSmartGroup, base_qty: newBaseQty }
      const result = await createCatalogItem(trimmed, newCategory, newUnit.trim() || 'units', parConfig)
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to add item.')
        return
      }
      setItems((prev) => [...prev, { id: result.id!, name: trimmed, category: newCategory, default_unit: newUnit.trim() || 'units', ...parConfig }])
      setNewName('')
      setNewParMode('static')
      setNewSmartGroup(null)
      setNewBaseQty(1)
      setError(null)
    })
  }

  const groups = groupByCategory(items)

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {canManage && (
        <div className="border border-themed rounded-xl p-4 flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <label htmlFor="new-catalog-item-name" className="text-xs font-medium text-secondary-themed">Item name</label>
            <input
              id="new-catalog-item-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
              placeholder="e.g. Dish Soap"
              className="input mt-1 w-full text-sm"
            />
          </div>
          <div>
            <label htmlFor="new-catalog-item-category" className="text-xs font-medium text-secondary-themed">Category</label>
            <select
              id="new-catalog-item-category"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as InventoryCategory)}
              className="input mt-1 text-sm"
            >
              {CATEGORY_ENTRIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="new-catalog-item-unit" className="text-xs font-medium text-secondary-themed">Unit</label>
            <input
              id="new-catalog-item-unit"
              value={newUnit}
              onChange={(e) => setNewUnit(e.target.value)}
              placeholder="units"
              className="input mt-1 w-24 text-sm"
            />
          </div>
          <div>
            <span className="text-xs font-medium text-secondary-themed">Par config</span>
            <div className="mt-1">
              <ParConfigControls
                item={{ par_mode: newParMode, smart_group: newSmartGroup, base_qty: newBaseQty }}
                onChange={(patch) => {
                  if (patch.par_mode !== undefined) setNewParMode(patch.par_mode)
                  if (patch.smart_group !== undefined) setNewSmartGroup(patch.smart_group)
                  if (patch.base_qty !== undefined) setNewBaseQty(patch.base_qty)
                }}
              />
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={handleAdd}
            disabled={saving || !newName.trim()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" /> Add Item
          </Button>
        </div>
      )}

      {groups.length === 0 && (
        <p className="text-sm text-muted-themed">No catalog items yet.</p>
      )}

      {groups.map(([category, categoryItems]) => (
        <div key={category} className="border border-themed rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold text-primary-themed" style={{ background: 'var(--bg-raised)' }}>
            {INVENTORY_CATEGORY_LABELS[category]}
          </div>
          <div className="divide-y divide-themed">
            {categoryItems.map((item) => (
              <div key={item.id} className="flex flex-col gap-1.5 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  {canManage ? (
                    <>
                      <input
                        value={item.name}
                        onChange={(e) => replaceItem(item.id, { name: e.target.value })}
                        onBlur={(e) => handleFieldChange(item, { name: e.target.value.trim() || item.name })}
                        className="flex-1 text-sm text-primary-themed bg-transparent focus:outline-none border-b border-transparent focus:border-[var(--accent-gold)] transition-colors"
                      />
                      <select
                        value={item.category}
                        onChange={(e) => handleFieldChange(item, { category: e.target.value as InventoryCategory })}
                        className="text-xs border border-themed rounded px-1.5 py-1 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                      >
                        {CATEGORY_ENTRIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <input
                        value={item.default_unit}
                        onChange={(e) => replaceItem(item.id, { default_unit: e.target.value })}
                        onBlur={(e) => handleFieldChange(item, { default_unit: e.target.value.trim() || item.default_unit })}
                        className="w-20 text-xs text-secondary-themed bg-transparent focus:outline-none border-b border-transparent focus:border-[var(--accent-gold)] transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        disabled={saving}
                        className="text-muted-themed hover:text-[var(--accent-red)] transition-colors p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-primary-themed">{item.name}</span>
                      <span className="text-xs text-muted-themed">{item.default_unit}</span>
                      <ParModeBadge par_mode={item.par_mode} smart_group={item.smart_group} />
                    </>
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <ParModeBadge par_mode={item.par_mode} smart_group={item.smart_group} />
                    <ParConfigControls
                      item={item}
                      onChange={(patch) => handleFieldChange(item, patch)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
