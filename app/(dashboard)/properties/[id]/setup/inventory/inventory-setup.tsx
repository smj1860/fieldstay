'use client'

import { useState, useTransition } from 'react'
import { upsertInventoryItems, deleteInventoryItem, completeInventoryStep, applyTemplateToProperty } from './actions'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
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
  templateId,
  templateName,
}: {
  propertyId: string
  catalogItems: InventoryCatalogItem[]
  existingItems: InventoryItem[]
  templateBrands?: Record<string, string | null>
  templateId?: string
  templateName?: string
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
  const [applying, startApply] = useTransition()
  const [applyResult, setApplyResult] = useState<{ added: number; skipped: number } | null>(null)

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

  const handleApplyTemplate = () => {
    if (!templateId) return
    startApply(async () => {
      const res = await applyTemplateToProperty(templateId, propertyId)
      if (res.error) {
        setError(res.error)
      } else {
        setApplyResult({ added: res.added, skipped: res.skipped })
        window.location.reload()
      }
    })
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="border text-sm rounded-lg px-4 py-3" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{error}</div>
      )}

      {templateId && items.length === 0 && (
        <div
          className="rounded-xl px-4 py-4 flex items-center justify-between gap-4"
          style={{ background: 'var(--accent-gold-dim)', border: '1px solid rgba(252,209,22,0.25)' }}
        >
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--accent-gold)' }}>
              Master template ready
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Apply &#34;{templateName ?? 'Master Inventory'}&#34; to populate this property in one click.
            </p>
          </div>
          <button
            onClick={handleApplyTemplate}
            disabled={applying}
            className="btn-cta text-xs whitespace-nowrap"
          >
            {applying ? 'Applying…' : 'Apply Template'}
          </button>
        </div>
      )}
      {applyResult && (
        <div className="rounded-lg px-4 py-3 text-sm flex items-center gap-2"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}>
          &#10003; {applyResult.added} items added, {applyResult.skipped} already existed.
        </div>
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
                  className="flex items-start gap-3 px-3 py-2.5 rounded-lg border"
                  style={item.isDirty
                    ? { borderColor: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' }
                    : { borderColor: 'var(--border)', background: 'var(--bg-canvas)' }
                  }
                >
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 items-center min-w-0">
                    <p className="text-sm font-medium text-primary-themed truncate col-span-2">{item.name}</p>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-themed">Par:</span>
                      <input
                        type="number" min="0" value={item.par_level}
                        onChange={(e) => {
                          const raw = e.target.value
                          // Allow clearing the field — treat empty as 0 only on blur
                          const n = raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0)
                          updateItem(idx, 'par_level', n)
                        }}
                        onBlur={(e) => {
                          if (e.target.value === '' || isNaN(Number(e.target.value))) {
                            updateItem(idx, 'par_level', 0)
                          }
                        }}
                        className="w-14 text-center text-sm border border-themed rounded px-1 py-0.5 bg-transparent text-primary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                      />
                    </div>
                    <select
                      value={item.unit}
                      onChange={(e) => updateItem(idx, 'unit', e.target.value)}
                      className="text-xs border border-themed rounded px-1 py-0.5 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                    >
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <div className="col-span-2 sm:col-span-4 flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        value={item.preferred_brand ?? ''}
                        onChange={(e) => updateItem(idx, 'preferred_brand', e.target.value.trim() || null)}
                        placeholder={templateBrand ? `Template: ${templateBrand}` : 'Brand (optional)'}
                        className="text-xs border border-themed rounded px-2 py-0.5 bg-transparent text-primary-themed placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)] w-40"
                      />
                      {isOverride && (
                        <span className="text-xs font-medium" style={{ color: 'var(--accent-amber)' }}>
                          ⚡ Property override
                        </span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => removeItem(item, idx)} className="text-muted-themed hover:text-red-500 transition-colors mt-0.5">
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
        <div className="border border-themed rounded-xl overflow-hidden">
          {Object.entries(catalogByCategory).map(([category, catItems]) => {
            const isOpen   = expandedCategories.has(category)
            const addedIds = new Set(items.map((i) => i.catalog_item_id).filter(Boolean))
            const available = catItems.filter((i) => !addedIds.has(i.id))

            return (
              <div key={category} className="border-b border-themed last:border-b-0">
                <button
                  onClick={() => setExpandedCategories((prev) => {
                    const next = new Set(prev)
                    isOpen ? next.delete(category) : next.add(category)
                    return next
                  })}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-raised-themed transition-colors"
                >
                  <span className="text-sm font-medium text-primary-themed">
                    {INVENTORY_CATEGORY_LABELS[category as InventoryCategory] ?? category}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-themed">{available.length} available</span>
                    {isOpen ? <ChevronDown className="w-4 h-4 text-muted-themed" /> : <ChevronRight className="w-4 h-4 text-muted-themed" />}
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
                          className={added
                            ? 'flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-all cursor-default'
                            : 'flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-all bg-canvas-themed text-secondary-themed hover:text-[var(--accent-gold)] hover:bg-[var(--accent-gold-dim)]'
                          }
                          style={added ? { background: 'var(--accent-green-dim)', color: 'var(--accent-green)' } : undefined}
                        >
                          <Plus className="w-3 h-3 flex-shrink-0" style={added ? { color: 'var(--accent-green)' } : undefined} />
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
        <div className="border border-themed rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-primary-themed">Custom Item</p>
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
              <input
                type="number" min="0" value={customItem.par_level}
                onChange={(e) => {
                  const n = e.target.value === '' ? 0 : Math.max(0, parseInt(e.target.value, 10) || 0)
                  setCustomItem((p) => ({ ...p, par_level: n }))
                }}
                className="input"
              />
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
      <div className="flex items-center gap-3 pt-4 border-t border-themed">
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
