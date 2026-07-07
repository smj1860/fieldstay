'use client'

import { useState, useTransition, useRef } from 'react'
import { upsertInventoryItems, deleteInventoryItem, bulkDeleteInventoryItems, completeInventoryStep, applyTemplateToProperty, cloneInventoryFromProperty } from './actions'
import { Plus, Trash2, ChevronDown, ChevronRight, Zap, Check, Upload } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Dialog } from '@/components/ui/Dialog'
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
  sourceProperties = [],
}: {
  propertyId: string
  catalogItems: InventoryCatalogItem[]
  existingItems: InventoryItem[]
  templateBrands?: Record<string, string | null>
  templateId?: string
  templateName?: string
  sourceProperties?: { id: string; name: string; itemCount: number }[]
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
  const [cloneModal, setCloneModal] = useState(false)
  const [cloneSource, setCloneSource] = useState('')
  const [cloning, startClone] = useTransition()
  const [, setCloneResult] = useState<{ added: number; skipped: number } | null>(null)

  // Bulk select / delete
  const [selectedIdxs, setSelectedIdxs]             = useState<Set<number>>(new Set())
  const [deletingSelected, startDeleteSelected]      = useTransition()

  // CSV import
  const csvRef                                       = useRef<HTMLInputElement | null>(null)
  const [csvPreview, setCsvPreview]                  = useState<
    Array<{ name: string; category: string; unit: string; par_level: number }>
  >([])
  const [showCsvImport, setShowCsvImport]            = useState(false)

  const parseCsv = (text: string) => {
    const lines   = text.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return []
    const headers = lines[0].toLowerCase().split(',').map((h) => h.trim())
    const nameIdx = headers.findIndex((h) => h.includes('name'))
    const catIdx  = headers.findIndex((h) => h.includes('cat'))
    const unitIdx = headers.findIndex((h) => h.includes('unit'))
    const parIdx  = headers.findIndex((h) => h.includes('par') || h.includes('level'))
    const hasHeader = nameIdx >= 0 || catIdx >= 0 || unitIdx >= 0
    const data    = hasHeader ? lines.slice(1) : lines
    return data
      .map((line) => {
        const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        return {
          name:      nameIdx >= 0 ? (cols[nameIdx] ?? '') : (cols[0] ?? ''),
          category:  catIdx  >= 0 ? (cols[catIdx]  ?? 'other') : 'other',
          unit:      unitIdx >= 0 ? (cols[unitIdx]  ?? 'units') : 'units',
          par_level: parIdx  >= 0 ? (parseFloat(cols[parIdx] ?? '1') || 1) : 1,
        }
      })
      .filter((r) => r.name)
  }

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
    // Shift selected indexes down past the removed slot
    setSelectedIdxs((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => {
        if (i < idx) next.add(i)
        else if (i > idx) next.add(i - 1)
      })
      return next
    })
  }

  const removeSelected = () => {
    startDeleteSelected(async () => {
      const idsToDelete = Array.from(selectedIdxs)
        .map((i) => items[i]?.id)
        .filter((id): id is string => !!id)
      if (idsToDelete.length > 0) {
        await bulkDeleteInventoryItems(idsToDelete, propertyId)
      }
      setItems((prev) => prev.filter((_, i) => !selectedIdxs.has(i)))
      setSelectedIdxs(new Set())
    })
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

  const handleClone = () => {
    if (!cloneSource) return
    startClone(async () => {
      const res = await cloneInventoryFromProperty(cloneSource, propertyId)
      if (res.error) { setError(res.error); return }
      setCloneResult({ added: res.added, skipped: res.skipped })
      setCloneModal(false)
      window.location.reload()
    })
  }

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
    <div className="space-y-6" suppressHydrationWarning>
      {error && (
        <div className="border text-sm rounded-lg px-4 py-3" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{error}</div>
      )}

      {items.length === 0 && sourceProperties.length > 0 && (
        <div
          className="rounded-xl px-4 py-4 flex items-center justify-between gap-4"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <div>
            <p className="text-sm font-semibold text-primary-themed">Copy from another property</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Duplicate the inventory list from an existing property.
            </p>
          </div>
          <button onClick={() => setCloneModal(true)} className="btn-secondary text-xs whitespace-nowrap">
            Clone Inventory
          </button>
        </div>
      )}

      <Dialog open={cloneModal} onClose={() => setCloneModal(false)} title="Clone Inventory From" maxWidthClassName="max-w-sm">
        <p className="text-xs text-muted-themed mb-4">
          Items already on this property will be skipped. Counts are not copied — only par levels and items.
        </p>
        <select
          value={cloneSource}
          onChange={e => setCloneSource(e.target.value)}
          className="input w-full mb-4"
          style={{ color: '#1a1d20' }}
        >
          <option value="">Select a property…</option>
          {sourceProperties.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.itemCount} items)
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <button
            onClick={handleClone}
            disabled={!cloneSource || cloning}
            className="btn-primary flex-1"
          >
            {cloning ? 'Cloning…' : 'Clone Items'}
          </button>
          <button onClick={() => setCloneModal(false)} className="btn-ghost">Cancel</button>
        </div>
      </Dialog>

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
          {/* Select-all header */}
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={items.length > 0 && selectedIdxs.size === items.length}
                onChange={() => {
                  if (selectedIdxs.size === items.length) {
                    setSelectedIdxs(new Set())
                  } else {
                    setSelectedIdxs(new Set(items.map((_, i) => i)))
                  }
                }}
                className="w-4 h-4 rounded"
                style={{ accentColor: 'var(--accent-gold)' }}
              />
              <p className="section-header" style={{ margin: 0 }}>
                Your Inventory ({items.length} items)
                {selectedIdxs.size > 0 && (
                  <span className="ml-1 font-normal text-muted-themed">
                    — {selectedIdxs.size} selected
                  </span>
                )}
              </p>
            </label>
            {selectedIdxs.size > 0 && (
              <button
                onClick={removeSelected}
                disabled={deletingSelected}
                className="text-xs font-medium"
                style={{ color: 'var(--accent-red)' }}
              >
                {deletingSelected
                  ? 'Removing…'
                  : `Remove ${selectedIdxs.size} item${selectedIdxs.size !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
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
                  <input
                    type="checkbox"
                    checked={selectedIdxs.has(idx)}
                    onChange={() => {
                      setSelectedIdxs((prev) => {
                        const next = new Set(prev)
                        next.has(idx) ? next.delete(idx) : next.add(idx)
                        return next
                      })
                    }}
                    className="w-4 h-4 rounded mt-0.5 flex-shrink-0"
                    style={{ accentColor: 'var(--accent-gold)' }}
                  />
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 items-center min-w-0">
                    <p className="text-sm font-medium text-primary-themed truncate col-span-2">{item.name}</p>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-themed">Par:</span>
                      <input
                        type="number" min="0" step="0.5" value={item.par_level}
                        onChange={(e) => {
                          const raw = e.target.value
                          const n = raw === '' ? 0 : Math.max(0, parseFloat(raw) || 0)
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
                      className="text-xs border border-themed rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                      style={{ color: '#1a1d20', backgroundColor: '#ffffff' }}
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
                        <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                          <Zap className="w-3 h-3" />
                          Property override
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
                    {available.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          available.forEach((ci) => addFromCatalog(ci))
                        }}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--accent-gold)' }}
                      >
                        Add all
                      </button>
                    )}
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
                          {added && <Check className="w-3 h-3 ml-auto" />}
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
              <label htmlFor="custom-item-name" className="label">Item Name</label>
              <input id="custom-item-name" value={customItem.name} onChange={(e) => setCustomItem((p) => ({ ...p, name: e.target.value }))} className="input" placeholder="e.g. Propane Tank" />
            </div>
            <div>
              <label htmlFor="custom-item-category" className="label">Category</label>
              <select id="custom-item-category" value={customItem.category} onChange={(e) => setCustomItem((p) => ({ ...p, category: e.target.value }))} className="input" style={{ color: '#1a1d20' }}>
                {Object.entries(INVENTORY_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="custom-item-unit" className="label">Unit</label>
              <select id="custom-item-unit" value={customItem.unit} onChange={(e) => setCustomItem((p) => ({ ...p, unit: e.target.value }))} className="input" style={{ color: '#1a1d20' }}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="custom-item-par-level" className="label">Par Level</label>
              <input id="custom-item-par-level"
                type="number" min="0" step="0.5" value={customItem.par_level}
                onChange={(e) => {
                  const n = e.target.value === '' ? 0 : Math.max(0, parseFloat(e.target.value) || 0)
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

      {/* CSV upload */}
      <input
        type="file"
        accept=".csv"
        ref={csvRef}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = (ev) => setCsvPreview(parseCsv(ev.target?.result as string))
          reader.readAsText(file)
          e.target.value = ''
        }}
      />

      {showCsvImport ? (
        <div className="border border-themed rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-primary-themed">Upload CSV</p>
            <button
              type="button"
              onClick={() => { setShowCsvImport(false); setCsvPreview([]) }}
              className="text-xs text-muted-themed hover:underline"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Columns: <code>Name, Category, Unit, Par Level</code> (header row optional).{' '}
            Category options: <code>paper_goods</code>, <code>cleaning</code>, <code>kitchen</code>,{' '}
            <code>bath</code>, <code>laundry</code>, <code>bedroom_linens</code>, <code>outdoor</code>,{' '}
            <code>maintenance_safety</code>, <code>guest_experience</code>, <code>technology</code>, <code>other</code>.
          </p>
          {csvPreview.length === 0 ? (
            <button
              type="button"
              onClick={() => csvRef.current?.click()}
              className="w-full border-2 border-dashed border-themed rounded-xl py-6 text-sm flex flex-col items-center gap-2 transition-colors hover:border-strong-themed"
              style={{ color: 'var(--text-muted)' }}
            >
              <Upload className="w-5 h-5" />
              Click to upload CSV
            </button>
          ) : (
            <>
              <div className="border border-themed rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: 'var(--bg-raised)' }}>
                      <th className="text-left px-3 py-2 text-muted-themed">Name</th>
                      <th className="text-left px-3 py-2 text-muted-themed">Category</th>
                      <th className="text-right px-3 py-2 text-muted-themed">Par</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.map((row, i) => (
                      <tr key={i} className="border-t border-themed">
                        <td className="px-3 py-1.5 text-primary-themed">{row.name}</td>
                        <td className="px-3 py-1.5 text-secondary-themed">{row.category}</td>
                        <td className="px-3 py-1.5 text-right text-secondary-themed">{row.par_level}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setItems((prev) => [
                      ...prev,
                      ...csvPreview.map((row) => ({
                        name:            row.name,
                        category:        row.category,
                        unit:            row.unit,
                        par_level:       row.par_level,
                        preferred_brand: null as null,
                        notes:           '',
                        isNew:           true,
                        isDirty:         true,
                      })),
                    ])
                    setCsvPreview([])
                    setShowCsvImport(false)
                  }}
                  className="btn-primary flex-1 text-sm"
                >
                  Add {csvPreview.length} items
                </button>
                <button
                  type="button"
                  onClick={() => setCsvPreview([])}
                  className="btn-ghost text-sm"
                >
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowCsvImport(true)}
          className="btn-secondary w-full justify-center border-dashed text-sm"
        >
          <Upload className="w-4 h-4" /> Upload CSV
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
