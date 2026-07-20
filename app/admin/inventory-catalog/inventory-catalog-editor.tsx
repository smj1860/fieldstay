'use client'

import { useMemo, useState, useTransition } from 'react'
import { Plus, Trash2, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { createCatalogItem, updateCatalogItem, deleteCatalogItem, type CatalogItemInput } from './actions'
import type { InventoryCategory } from '@/types/database'

const CATEGORIES = Object.keys(INVENTORY_CATEGORY_LABELS) as InventoryCategory[]

interface RowState {
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
  description:  string
  is_active:    boolean
  dirty:        boolean
}

function toRowState(item: Omit<RowState, 'dirty'>): RowState {
  return { ...item, dirty: false }
}

function updateRowField(rows: RowState[], id: string, field: keyof RowState, value: unknown): RowState[] {
  return rows.map((r) => (r.id === id ? { ...r, [field]: value, dirty: true } : r))
}

function matchesFilter(row: RowState, search: string, categoryFilter: string): boolean {
  if (categoryFilter !== 'all' && row.category !== categoryFilter) return false
  if (!search) return true
  return row.name.toLowerCase().includes(search.toLowerCase())
}

export function InventoryCatalogEditor({
  initialItems,
}: Readonly<{
  initialItems: Array<{ id: string; name: string; category: InventoryCategory; default_unit: string; description: string; is_active: boolean }>
}>) {
  const [rows, setRows] = useState<RowState[]>(() => initialItems.map(toRowState))
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [saving, startSave] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedRowId, setSavedRowId] = useState<string | null>(null)

  const [newItem, setNewItem] = useState<CatalogItemInput>({
    name: '', category: 'other', default_unit: 'units', description: '', is_active: true,
  })

  const visibleRows = useMemo(
    () => rows.filter((r) => matchesFilter(r, search, categoryFilter)),
    [rows, search, categoryFilter]
  )

  function handleFieldChange(id: string, field: keyof RowState, value: unknown) {
    setRows((prev) => updateRowField(prev, id, field, value))
  }

  function handleSaveRow(row: RowState) {
    startSave(async () => {
      setError(null)
      const result = await updateCatalogItem(row.id, {
        name:         row.name,
        category:     row.category,
        default_unit: row.default_unit,
        description:  row.description,
        is_active:    row.is_active,
      })
      if (result.error) { setError(result.error); return }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, dirty: false } : r)))
      setSavedRowId(row.id)
      setTimeout(() => setSavedRowId(null), 2000)
    })
  }

  function handleDeleteRow(id: string) {
    startSave(async () => {
      setError(null)
      const result = await deleteCatalogItem(id)
      if (result.error) { setError(result.error); return }
      setRows((prev) => prev.filter((r) => r.id !== id))
    })
  }

  function handleCreate() {
    if (!newItem.name.trim()) return
    startSave(async () => {
      setError(null)
      const result = await createCatalogItem(newItem)
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to create item.')
        return
      }
      setRows((prev) => [...prev, toRowState({ id: result.id!, ...newItem })])
      setNewItem({ name: '', category: 'other', default_unit: 'units', description: '', is_active: true })
    })
  }

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="input text-sm flex-1 min-w-[180px]"
          aria-label="Search catalog items"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="input text-sm"
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
        </select>
      </div>

      <div className="border border-themed rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-themed text-left">
              <th className="px-3 py-2 font-medium text-muted-themed">Name</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Category</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Unit</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Description</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Active</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-themed">
            {visibleRows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">
                  <input
                    value={row.name}
                    onChange={(e) => handleFieldChange(row.id, 'name', e.target.value)}
                    className="input text-sm w-full"
                    aria-label="Item name"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={row.category}
                    onChange={(e) => handleFieldChange(row.id, 'category', e.target.value)}
                    className="input text-sm"
                    aria-label="Item category"
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.default_unit}
                    onChange={(e) => handleFieldChange(row.id, 'default_unit', e.target.value)}
                    className="input text-sm w-20"
                    aria-label="Default unit"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.description}
                    onChange={(e) => handleFieldChange(row.id, 'description', e.target.value)}
                    className="input text-sm w-full"
                    aria-label="Item description"
                  />
                </td>
                <td className="px-3 py-2">
                  <Checkbox
                    checked={row.is_active}
                    onChange={() => handleFieldChange(row.id, 'is_active', !row.is_active)}
                    aria-label="Item active"
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => handleSaveRow(row)}
                      disabled={saving || !row.dirty}
                      className="text-xs inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      {savedRowId === row.id ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeleteRow(row.id)}
                      disabled={saving}
                      className="p-1 text-muted-themed hover:text-red-500"
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-themed text-sm">
                  No items match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border border-themed rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Add New Item</h3>
        <div className="grid gap-2 sm:grid-cols-5">
          <input
            value={newItem.name}
            onChange={(e) => setNewItem((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Item name"
            className="input text-sm sm:col-span-2"
          />
          <select
            value={newItem.category}
            onChange={(e) => setNewItem((prev) => ({ ...prev, category: e.target.value as InventoryCategory }))}
            className="input text-sm"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
          </select>
          <input
            value={newItem.default_unit}
            onChange={(e) => setNewItem((prev) => ({ ...prev, default_unit: e.target.value }))}
            placeholder="Unit"
            className="input text-sm"
          />
          <input
            value={newItem.description}
            onChange={(e) => setNewItem((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Description (optional)"
            className="input text-sm"
          />
        </div>
        <Button
          variant="secondary"
          onClick={handleCreate}
          disabled={saving || !newItem.name.trim()}
          className="mt-3 inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Add Item
        </Button>
      </div>
    </div>
  )
}
