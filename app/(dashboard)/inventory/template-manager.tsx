'use client'

import { useState, useTransition, useRef } from 'react'
import { Plus, X, Loader2, Check, Upload } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import {
  createOrGetTemplate,
  addTemplateItem,
  bulkAddTemplateItems,
  removeTemplateItem,
  updateTemplateItemBrand,
  applyTemplateToProperty,
  applyTemplateToProperties,
} from './actions'
import type { InventoryCategory } from '@/types/database'

interface TemplateItem {
  id: string
  name: string
  category: string
  unit: string
  par_level: number
  notes: string | null
  preferred_brand: string | null
}

interface Template {
  id: string
  name: string
  inventory_template_items: TemplateItem[] | null
}

interface Property {
  id: string
  name: string
}

interface CatalogItem {
  id:           string
  name:         string
  category:     string
  default_unit: string
}

const CATEGORY_ORDER: InventoryCategory[] = [
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other',
]

function TemplateBrandInput({ itemId, defaultBrand }: { itemId: string; defaultBrand: string | null }) {
  const [value, setValue]       = useState(defaultBrand ?? '')
  const [, startTransition]     = useTransition()

  const handleBlur = () => {
    const brand = value.trim() || null
    startTransition(async () => {
      await updateTemplateItemBrand(itemId, brand)
    })
  }

  return (
    <input
      type="text"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={handleBlur}
      placeholder="Any brand"
      className="input py-0.5 px-2 text-xs w-28 flex-shrink-0"
      title="Preferred brand — used when building Kroger cart"
    />
  )
}

function parseSimpleCsv(text: string) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].toLowerCase().split(',').map(h => h.trim())
  const nameIdx = headers.findIndex(h => h.includes('name'))
  const catIdx  = headers.findIndex(h => h.includes('cat'))
  const unitIdx = headers.findIndex(h => h.includes('unit'))
  const parIdx  = headers.findIndex(h => h.includes('par') || h.includes('level'))
  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    return {
      name:      nameIdx >= 0 ? cols[nameIdx] ?? '' : '',
      category:  catIdx  >= 0 ? cols[catIdx]  ?? 'other' : 'other',
      unit:      unitIdx >= 0 ? cols[unitIdx]  ?? 'units' : 'units',
      par_level: parIdx  >= 0 ? parseFloat(cols[parIdx] ?? '1') || 1 : 1,
    }
  }).filter(r => r.name)
}

export function TemplateManager({
  template,
  properties,
  orgId,
  catalogItems = [],
}: {
  template:     Template | null
  properties:   Property[]
  orgId:        string
  catalogItems: CatalogItem[]
}) {
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(template)
  const [creating, setCreating]               = useState(false)
  const [applyModal, setApplyModal]           = useState(false)
  const [selectedProps, setSelectedProps]     = useState<Set<string>>(new Set())
  const [isPending, startTransition]          = useTransition()
  const [error, setError]                     = useState<string | null>(null)
  const [success, setSuccess]                 = useState<string | null>(null)

  // Add item tabs
  const [addTab, setAddTab] = useState<'catalog' | 'custom' | 'csv'>('catalog')

  // Catalog tab state
  const [catalogFilter, setCatalogFilter]     = useState<InventoryCategory | 'all'>('all')
  const [catalogSelected, setCatalogSelected] = useState<Set<string>>(new Set())
  const [catalogParLevels, setCatalogParLevels] = useState<Record<string, string>>({})
  const [catalogUnits, setCatalogUnits]         = useState<Record<string, string>>({})
  const [catalogBrands, setCatalogBrands]       = useState<Record<string, string>>({})

  // Custom tab state
  const [newName,     setNewName]     = useState('')
  const [newCategory, setNewCategory] = useState<InventoryCategory>('other')
  const [newUnit,     setNewUnit]     = useState('')
  const [newPar,      setNewPar]      = useState('1')
  const [newBrand,    setNewBrand]    = useState('')

  // CSV tab state
  const csvInputRef = useRef<HTMLInputElement | null>(null)
  const [csvPreview, setCsvPreview] = useState<
    { name: string; category: string; unit: string; par_level: number }[]
  >([])

  const handleCreateTemplate = () => {
    setCreating(true)
    startTransition(async () => {
      const result = await createOrGetTemplate()
      if (result.error) {
        setError(result.error)
      } else if (result.template) {
        setCurrentTemplate(result.template as Template)
      }
      setCreating(false)
    })
  }

  const handleAddItem = () => {
    if (!currentTemplate || !newName.trim() || !newUnit.trim()) return
    setError(null)
    startTransition(async () => {
      const result = await addTemplateItem(currentTemplate.id, {
        name:            newName.trim(),
        category:        newCategory,
        unit:            newUnit.trim(),
        par_level:       parseFloat(newPar) || 1,
        preferred_brand: newBrand.trim() || null,
      })
      if (result.error) {
        setError(result.error)
      } else if (result.item) {
        setCurrentTemplate(prev => prev ? {
          ...prev,
          inventory_template_items: [...(prev.inventory_template_items ?? []), result.item!],
        } : prev)
        setNewName(''); setNewUnit(''); setNewPar('1'); setNewBrand('')
      }
    })
  }

  const handleRemoveItem = (itemId: string) => {
    startTransition(async () => {
      await removeTemplateItem(itemId)
      setCurrentTemplate(prev => prev ? {
        ...prev,
        inventory_template_items: (prev.inventory_template_items ?? []).filter(i => i.id !== itemId),
      } : prev)
    })
  }

  const handleAddCatalogItems = () => {
    if (!currentTemplate) return
    setError(null)
    const itemsToAdd = catalogItems.filter(c => catalogSelected.has(c.id))
    startTransition(async () => {
      const newItems: TemplateItem[] = []
      for (const c of itemsToAdd) {
        const result = await addTemplateItem(currentTemplate.id, {
          name:            c.name,
          category:        c.category,
          unit:            catalogUnits[c.id]   ?? c.default_unit,
          par_level:       parseInt(catalogParLevels[c.id] ?? '1') || 1,
          preferred_brand: catalogBrands[c.id]?.trim() || null,
        })
        if (result.item) newItems.push(result.item as TemplateItem)
      }
      setCurrentTemplate(prev => prev ? {
        ...prev,
        inventory_template_items: [
          ...(prev.inventory_template_items ?? []),
          ...newItems,
        ],
      } : prev)
      setCatalogSelected(new Set())
      setCatalogParLevels({})
      setCatalogUnits({})
      setCatalogBrands({})
    })
  }

  const handleCsvSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      setCsvPreview(parseSimpleCsv(text))
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleImportCsv = () => {
    if (!currentTemplate || !csvPreview.length) return
    startTransition(async () => {
      const result = await bulkAddTemplateItems(
        currentTemplate.id,
        csvPreview.map((row) => ({
          name:      row.name,
          category:  row.category,
          unit:      row.unit,
          par_level: row.par_level,
        }))
      )
      if (result.items?.length) {
        setCurrentTemplate(prev => prev ? {
          ...prev,
          inventory_template_items: [
            ...(prev.inventory_template_items ?? []),
            ...(result.items as TemplateItem[]),
          ],
        } : prev)
      }
      setCsvPreview([])
      setAddTab('catalog')
    })
  }

  const handleApply = () => {
    if (!currentTemplate || selectedProps.size === 0) return
    setError(null)
    startTransition(async () => {
      const result = await applyTemplateToProperties(currentTemplate.id, Array.from(selectedProps))
      const count = selectedProps.size
      setSelectedProps(new Set())
      if (result.error) {
        setError(result.error)
      } else {
        setSuccess(`Applied to ${count} propert${count !== 1 ? 'ies' : 'y'}. ${result.applied} items added.`)
        setTimeout(() => setSuccess(null), 5000)
      }
      setApplyModal(false)
    })
  }

  const templateItems = currentTemplate?.inventory_template_items ?? []

  if (!currentTemplate) {
    return (
      <div className="card text-center py-12">
        <h3 className="font-semibold text-secondary-themed mb-2">No Master Template Yet</h3>
        <p className="text-sm text-muted-themed mb-4">
          Create a master inventory template to quickly set up new properties.
        </p>
        <button
          onClick={handleCreateTemplate}
          disabled={creating}
          className="btn-primary"
        >
          {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</> : <><Plus className="w-4 h-4" /> Create Master Template</>}
        </button>
        {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
      </div>
    )
  }

  const byCategory = CATEGORY_ORDER
    .map(cat => ({ cat, catItems: templateItems.filter(i => i.category === cat) }))
    .filter(({ catItems }) => catItems.length > 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-primary-themed">{currentTemplate.name}</h3>
          <p className="text-xs text-muted-themed mt-0.5">{templateItems.length} items</p>
        </div>
        {properties.length > 0 && (
          <button onClick={() => setApplyModal(true)} className="btn-secondary text-xs">
            Apply to Property…
          </button>
        )}
      </div>

      {success && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm"
             style={{ background: 'var(--accent-green-dim, rgba(16,185,129,0.1))', color: 'var(--accent-green)' }}>
          <Check className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {/* Template items list */}
      {byCategory.length > 0 ? (
        <div className="border border-themed rounded-xl overflow-hidden">
          {byCategory.map(({ cat, catItems }) => (
            <div key={cat}>
              <div className="px-4 py-2 bg-canvas-themed border-b border-themed">
                <span className="text-xs font-semibold text-muted-themed uppercase tracking-wide">
                  {INVENTORY_CATEGORY_LABELS[cat]}
                </span>
              </div>
              {catItems.map(item => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-primary-themed">{item.name}</span>
                    <span className="text-xs text-muted-themed ml-2">
                      Par {item.par_level} {item.unit}
                    </span>
                  </div>
                  <TemplateBrandInput itemId={item.id} defaultBrand={item.preferred_brand} />
                  <button
                    onClick={() => handleRemoveItem(item.id)}
                    disabled={isPending}
                    className="flex-shrink-0 text-muted-themed hover:text-red-500 p-1 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="border border-dashed border-themed rounded-xl px-4 py-8 text-center text-sm text-muted-themed">
          No items yet. Add items below to build your master template.
        </div>
      )}

      {/* Add item — tabbed */}
      <div className="card p-4 space-y-3">
        {/* Tab bar */}
        <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: 'var(--bg-raised)' }}>
          {(['catalog', 'custom', 'csv'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setAddTab(tab)}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize"
              style={addTab === tab
                ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                : { color: 'var(--text-muted)' }}
            >
              {tab === 'catalog' ? 'From Catalog' : tab === 'csv' ? 'Upload CSV' : 'Custom'}
            </button>
          ))}
        </div>

        {/* From Catalog tab */}
        {addTab === 'catalog' && (
          <div className="space-y-3">
            <div className="px-3 py-2.5 rounded-lg text-xs" style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              If you always buy a specific brand — Bounty paper towels, Dawn dish soap, Tide pods — enter it in the Brand field. Without it, the cart may pull in a store brand and you'll have to swap it out manually every time.
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {(['all', ...CATEGORY_ORDER] as const).map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCatalogFilter(c)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-full border transition-colors',
                    catalogFilter === c
                      ? 'bg-brand-800 text-white border-brand-800'
                      : 'border-themed text-secondary-themed hover:text-primary-themed'
                  )}
                >
                  {c === 'all' ? 'All' : INVENTORY_CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>

            {catalogItems.length === 0 ? (
              <p className="text-xs text-muted-themed py-4 text-center">
                No catalog items found. Add items to a property first, or use the Custom tab.
              </p>
            ) : (() => {
              const visibleItems = catalogItems.filter(c => catalogFilter === 'all' || c.category === catalogFilter)
              const selectableItems = visibleItems.filter(c => !templateItems.some(t => t.name.toLowerCase() === c.name.toLowerCase()))
              const allSelected = selectableItems.length > 0 && selectableItems.every(c => catalogSelected.has(c.id))
              return (
                <div className="border border-themed rounded-xl overflow-hidden">
                  {/* Select all header */}
                  <div className="flex items-center gap-3 px-4 py-2 border-b border-themed"
                       style={{ background: 'var(--bg-raised)' }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        setCatalogSelected(prev => {
                          const next = new Set(prev)
                          if (allSelected) {
                            selectableItems.forEach(c => next.delete(c.id))
                          } else {
                            selectableItems.forEach(c => next.add(c.id))
                          }
                          return next
                        })
                      }}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                      Select all ({selectableItems.length})
                    </span>
                  </div>
                  <div className="max-h-52 overflow-y-auto">
                    {visibleItems.map(c => {
                      const alreadyInTemplate = templateItems.some(t => t.name.toLowerCase() === c.name.toLowerCase())
                      const isSelected        = catalogSelected.has(c.id)
                      return (
                        <div
                          key={c.id}
                          className={cn('border-b border-themed last:border-0 transition-colors', alreadyInTemplate ? 'opacity-40' : '')}
                          style={isSelected ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)' } : {}}
                        >
                          <div
                            className={cn('flex items-center gap-3 px-4 py-2.5', alreadyInTemplate ? 'cursor-not-allowed' : 'cursor-pointer')}
                            onClick={() => {
                              if (alreadyInTemplate) return
                              setCatalogSelected(prev => {
                                const next = new Set(prev)
                                next.has(c.id) ? next.delete(c.id) : next.add(c.id)
                                return next
                              })
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              readOnly
                              disabled={alreadyInTemplate}
                              className="w-4 h-4 rounded flex-shrink-0"
                            />
                            <span className="flex-1 text-sm font-medium text-primary-themed">{c.name}</span>
                            <span className="text-xs text-muted-themed capitalize">
                              {c.category.replace('_', ' ')}
                            </span>
                            {alreadyInTemplate && (
                              <span className="text-xs text-muted-themed italic ml-1">in template</span>
                            )}
                          </div>
                          {isSelected && !alreadyInTemplate && (
                            <div className="flex items-center gap-2 px-4 pb-2.5 flex-wrap" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center gap-1.5">
                                <label className="text-xs text-muted-themed whitespace-nowrap">Par:</label>
                                <input
                                  type="number"
                                  min={1}
                                  value={catalogParLevels[c.id] ?? '1'}
                                  onChange={e => setCatalogParLevels(prev => ({ ...prev, [c.id]: e.target.value }))}
                                  onBlur={e => {
                                    if (!e.target.value || parseInt(e.target.value) < 1) {
                                      setCatalogParLevels(prev => ({ ...prev, [c.id]: '1' }))
                                    }
                                  }}
                                  className="input w-16 py-0.5 text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <label className="text-xs text-muted-themed whitespace-nowrap">Unit:</label>
                                <input
                                  type="text"
                                  value={catalogUnits[c.id] ?? c.default_unit}
                                  onChange={e => setCatalogUnits(prev => ({ ...prev, [c.id]: e.target.value }))}
                                  className="input w-20 py-0.5 text-xs"
                                  placeholder={c.default_unit}
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <label className="text-xs text-muted-themed whitespace-nowrap">Brand:</label>
                                <input
                                  type="text"
                                  value={catalogBrands[c.id] ?? ''}
                                  onChange={e => setCatalogBrands(prev => ({ ...prev, [c.id]: e.target.value }))}
                                  className="input w-28 py-0.5 text-xs"
                                  placeholder="Any"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {catalogSelected.size > 0 && (
              <button
                onClick={handleAddCatalogItems}
                disabled={isPending}
                className="btn-primary text-sm w-full"
              >
                {isPending
                  ? 'Adding…'
                  : `Add ${catalogSelected.size} item${catalogSelected.size !== 1 ? 's' : ''} to Template`}
              </button>
            )}
          </div>
        )}

        {/* Custom tab */}
        {addTab === 'custom' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="input"
                  placeholder="e.g. Paper Towels"
                />
              </div>
              <div>
                <label className="label">Unit *</label>
                <input
                  type="text"
                  value={newUnit}
                  onChange={e => setNewUnit(e.target.value)}
                  className="input"
                  placeholder="rolls, boxes…"
                />
              </div>
              <div>
                <label className="label">Category</label>
                <select value={newCategory} onChange={e => setNewCategory(e.target.value as InventoryCategory)} className="input">
                  {CATEGORY_ORDER.map(c => (
                    <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Par Level</label>
                <input
                  type="number" min={0} step={0.5}
                  value={newPar}
                  onChange={e => setNewPar(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Brand <span className="text-muted-themed font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={newBrand}
                  onChange={e => setNewBrand(e.target.value)}
                  className="input"
                  placeholder="e.g. Bounty, Dawn, Tide"
                />
              </div>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <button
              onClick={handleAddItem}
              disabled={isPending || !newName.trim() || !newUnit.trim()}
              className="btn-primary text-sm"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add to Template
            </button>
          </div>
        )}

        {/* CSV Upload tab */}
        {addTab === 'csv' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-themed">
              Upload a CSV with columns: <code className="font-mono">Name, Category, Unit, Par Level</code>.
              Category must be one of: {CATEGORY_ORDER.join(', ')}.
            </p>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              ref={csvInputRef}
              className="hidden"
              onChange={handleCsvSelect}
            />
            {csvPreview.length === 0 ? (
              <button
                type="button"
                onClick={() => csvInputRef.current?.click()}
                className="w-full border-2 border-dashed border-themed rounded-xl py-6 text-sm text-muted-themed hover:border-brand-400 transition-colors flex flex-col items-center gap-2"
              >
                <Upload className="w-5 h-5" />
                Click to upload CSV or spreadsheet
              </button>
            ) : (
              <>
                <div className="border border-themed rounded-xl overflow-hidden max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: 'var(--bg-canvas)' }}>
                        <th className="text-left px-3 py-2 text-muted-themed">Name</th>
                        <th className="text-left px-3 py-2 text-muted-themed">Category</th>
                        <th className="text-left px-3 py-2 text-muted-themed">Unit</th>
                        <th className="text-right px-3 py-2 text-muted-themed">Par</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreview.map((row, i) => (
                        <tr key={i} className="border-t border-themed">
                          <td className="px-3 py-1.5 text-primary-themed">{row.name}</td>
                          <td className="px-3 py-1.5 text-secondary-themed">{row.category}</td>
                          <td className="px-3 py-1.5 text-secondary-themed">{row.unit}</td>
                          <td className="px-3 py-1.5 text-right text-secondary-themed">{row.par_level}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleImportCsv}
                    disabled={isPending}
                    className="btn-primary flex-1 text-sm"
                  >
                    {isPending ? 'Importing…' : `Import ${csvPreview.length} items`}
                  </button>
                  <button
                    onClick={() => setCsvPreview([])}
                    className="btn-ghost text-sm"
                  >
                    Clear
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Apply to property modal */}
      {applyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-md">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-themed">
              <h3 className="font-semibold text-primary-themed">Apply Template to Properties</h3>
              <button onClick={() => setApplyModal(false)} className="btn-ghost p-1.5">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-2 max-h-60 overflow-y-auto">
              <label className="flex items-center gap-3 cursor-pointer py-1.5 border-b border-themed pb-3 mb-1">
                <input
                  type="checkbox"
                  checked={properties.length > 0 && properties.every(p => selectedProps.has(p.id))}
                  onChange={e => {
                    const next = new Set<string>()
                    if (e.target.checked) properties.forEach(p => next.add(p.id))
                    setSelectedProps(next)
                  }}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm font-medium text-primary-themed">Select all properties</span>
              </label>
              {properties.map(p => (
                <label key={p.id} className="flex items-center gap-3 cursor-pointer py-1.5">
                  <input
                    type="checkbox"
                    checked={selectedProps.has(p.id)}
                    onChange={e => {
                      const next = new Set(selectedProps)
                      if (e.target.checked) next.add(p.id)
                      else next.delete(p.id)
                      setSelectedProps(next)
                    }}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-sm text-primary-themed">{p.name}</span>
                </label>
              ))}
            </div>
            <div className="px-5 pb-5 pt-3 border-t border-themed flex gap-3">
              <button
                onClick={handleApply}
                disabled={isPending || selectedProps.size === 0}
                className="btn-primary flex-1"
              >
                {isPending ? 'Applying…' : `Apply to ${selectedProps.size} propert${selectedProps.size !== 1 ? 'ies' : 'y'}`}
              </button>
              <button onClick={() => setApplyModal(false)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
