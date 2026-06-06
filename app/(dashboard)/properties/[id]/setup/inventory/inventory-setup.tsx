'use client'

import { useState, useTransition } from 'react'
import { upsertInventoryItems, deleteInventoryItem, completeInventoryStep } from './actions'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import type { InventoryCatalogItem, InventoryItem, InventoryCategory } from '@/types/database'

interface EditableItem {
  id?: string
  catalog_item_id?: string | null
  name: string
  category: string
  unit: string
  par_level: number
  preferred_brand: string | null
  notes: string
  isNew?: boolean
  isDirty?: boolean
}

const UNITS = ['rolls', 'bottles', 'count', 'boxes', 'bags', 'sets', 'packs', 'gallons', 'units']

export function InventorySetup({
  propertyId,
  catalogItems,
  existingItems,
  templateBrands = {},
}: {
  propertyId: string
  catalogItems: InventoryCatalogItem[]
  existingItems: InventoryItem[]
  templateBrands?: Record<string, string | null>
}) {
  const [items, setItems] = useState<EditableItem[]>(
    existingItems.map((i) => ({
      id: i.id, catalog_item_id: i.catalog_item_id,
      name: i.name, category: i.category, unit: i.unit,
      par_level: i.par_level, preferred_brand: (i as { preferred_brand?: string | null }).preferred_brand ?? null,
      notes: i.notes ?? '', isDirty: false,
    }))
  )
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['paper_goods']))
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customItem, setCustomItem] = useState({ name: '', category: 'other', unit: 'units', par_level: 1, notes: '' })
  const [saving, startSave] = useTransition()
  const [completing, startComplete] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Group catalog by category
  const catalogByCategory = catalogItems.reduce<Record<string, InventoryCatalogItem[]>>((acc, item) => {
    const cat = item.category
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  const addFromCatalog = (catalogItem: InventoryCatalogItem) => {
    if (items.some((i) => i.catalog_item_id === catalogItem.id)) return
    const templateBrand = templateBrands[catalogItem.name.toLowerCase()] ?? null
    setItems((prev) => [...prev, {
      catalog_item_id: catalogItem.id,
      name: catalogItem.name, category: catalogItem.category,
      unit: catalogItem.default_unit, par_level: 2, preferred_brand: templateBrand,
      notes: '', isNew: true, isDirty: true,
    }])
  }

  const removeItem = async (item: EditableItem, idx: number) => {
    if (item.id) {
      await deleteInventoryItem(item.id, propertyId)
    }
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const updateItem = (idx: number, field: keyof EditableItem, value: unknown) => {
    setItems((prev) => prev.map((item, i) =>
      i === idx ? { ...item, [field]: value, isDirty: true } : item
    ))
  }

  const addCustom = () => {
    if (!customItem.name.trim()) return
    setItems((prev) => [...prev, { ...customItem, preferred_brand: null, isNew: true, isDirty: true }])
    setCustomItem({ name: '', category: 'other', unit: 'units', par_level: 1, notes: '' })
    setShowCustomForm(false)
  }

  const saveAll = () => {
    const dirty = items.filter((i) => i.isDirty)
    if (!dirty.length) return
    startSave(async () => {
      const result = await upsertInventoryItems(propertyId, dirty)
      if (result.error) { setError(result.error); return }
      setItems((prev) => prev.map((i) => ({ ...i, isDirty: false, isNew: false })))
    })
  }

  const dirtyCount = items.filter((i) => i.isDirty).length

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {/* Current item list */}
      {items.length > 0 && (
        <div>
          <p className="section-header">Your Inventory ({items.length} items)</p>
          <div className="space-y-2">
            {items.map((item, idx) => {
              const templateBrand = templateBrands[item.name.toLowerCase()] ?? null
              const isOverride = item.preferred_brand !== null && item.preferred_brand !== '' &&
                templateBrand !== null && item.preferred_brand !== templateBrand
              return (
                <div key={item.id ?? `new-${idx}`}
                  className={cn('flex items-start gap-3 px-3 py-2.5 rounded-lg border',
                    item.isDirty ? 'border-amber-200 bg-amber-50' : 'border-accent-100 bg-accent-50'
                  )}
                >
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 items-center min-w-0">
                    <p className="text-sm font-medium text-accent-800 truncate col-span-2">{item.name}</p>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-accent-400">Par:</span>
                      <input
                        type="number" min="0" value={item.par_level}
                        onChange={(e) => updateItem(idx, 'par_level', parseInt(e.target.value) || 0)}
                        className="w-14 text-center text-sm border border-accent-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                    <select
                      value={item.unit}
                      onChange={(e) => updateItem(idx, 'unit', e.target.value)}
                      className="text-xs border border-accent-200 rounded px-1 py-0.5 text-accent-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <div className="col-span-2 sm:col-span-4 flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        value={item.preferred_brand ?? ''}
                        onChange={(e) => updateItem(idx, 'preferred_brand', e.target.value.trim() || null)}
                        placeholder={templateBrand ? `Template: ${templateBrand}` : 'Brand (optional)'}
                        className="text-xs border border-accent-200 rounded px-2 py-0.5 text-accent-700 focus:outline-none focus:ring-1 focus:ring-brand-500 w-40"
                      />
                      {isOverride && (
                        <span className="text-xs font-medium" style={{ color: 'var(--accent-amber)' }}>
                          ⚡ Property override
                        </span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => removeItem(item, idx)} className="text-accent-300 hover:text-red-500 transition-colors mt-0.5">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
          </div>
          {dirtyCount > 0 && (
            <button onClick={saveAll} disabled={saving} className="btn-secondary text-sm mt-3">
              {saving ? 'Saving…' : `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      )}

      {/* Catalog picker */}
      <div>
        <p className="section-header">Add from Catalog</p>
        <div className="border border-accent-200 rounded-xl overflow-hidden">
          {Object.entries(catalogByCategory).map(([category, catItems]) => {
            const isOpen   = expandedCategories.has(category)
            const addedIds = new Set(items.map((i) => i.catalog_item_id).filter(Boolean))
            const available = catItems.filter((i) => !addedIds.has(i.id))

            return (
              <div key={category} className="border-b border-accent-100 last:border-b-0">
                <button
                  onClick={() => setExpandedCategories((prev) => {
                    const next = new Set(prev)
                    isOpen ? next.delete(category) : next.add(category)
                    return next
                  })}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-accent-50 transition-colors"
                >
                  <span className="text-sm font-medium text-accent-700">
                    {INVENTORY_CATEGORY_LABELS[category as InventoryCategory] ?? category}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-accent-400">{available.length} available</span>
                    {isOpen ? <ChevronDown className="w-4 h-4 text-accent-400" /> : <ChevronRight className="w-4 h-4 text-accent-400" />}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {catItems.map((ci) => {
                      const added = addedIds.has(ci.id)
                      return (
                        <button
                          key={ci.id}
                          onClick={() => !added && addFromCatalog(ci)}
                          disabled={added}
                          className={cn(
                            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-all',
                            added
                              ? 'bg-green-50 text-green-600 cursor-default'
                              : 'bg-accent-50 text-accent-700 hover:bg-brand-50 hover:text-brand-700'
                          )}
                        >
                          <Plus className={cn('w-3 h-3 flex-shrink-0', added && 'text-green-500')} />
                          {ci.name}
                          {added && <span className="ml-auto text-xs">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Custom item */}
      {showCustomForm ? (
        <div className="border border-accent-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-accent-700">Custom Item</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Item Name</label>
              <input value={customItem.name} onChange={(e) => setCustomItem((p) => ({ ...p, name: e.target.value }))} className="input" placeholder="e.g. Propane Tank" />
            </div>
            <div>
              <label className="label">Category</label>
              <select value={customItem.category} onChange={(e) => setCustomItem((p) => ({ ...p, category: e.target.value }))} className="input">
                {Object.entries(INVENTORY_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Unit</label>
              <select value={customItem.unit} onChange={(e) => setCustomItem((p) => ({ ...p, unit: e.target.value }))} className="input">
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Par Level</label>
              <input type="number" min="0" value={customItem.par_level} onChange={(e) => setCustomItem((p) => ({ ...p, par_level: parseInt(e.target.value) || 0 }))} className="input" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addCustom} className="btn-primary text-sm">Add Item</button>
            <button onClick={() => setShowCustomForm(false)} className="btn-ghost text-sm">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowCustomForm(true)} className="btn-secondary w-full justify-center border-dashed">
          <Plus className="w-4 h-4" /> Add Custom Item
        </button>
      )}

      {/* Continue */}
      <div className="flex items-center gap-3 pt-4 border-t border-accent-100">
        <button
          disabled={completing}
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
          className="btn-primary"
        >
          {completing ? 'Saving…' : items.length > 0 ? 'Save & Continue →' : 'Skip for now →'}
        </button>
      </div>
    </div>
  )
}
