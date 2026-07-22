'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { createCatalogItem, updateCatalogItem, deleteCatalogItem } from '../actions'
import type { InventoryCategory } from '@/types/database'

interface CatalogItemRow {
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
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
      const result = await createCatalogItem(trimmed, newCategory, newUnit.trim() || 'units')
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to add item.')
        return
      }
      setItems((prev) => [...prev, { id: result.id!, name: trimmed, category: newCategory, default_unit: newUnit.trim() || 'units' }])
      setNewName('')
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
              <div key={item.id} className="flex items-center gap-2 px-4 py-2.5">
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
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
