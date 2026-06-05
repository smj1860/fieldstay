'use client'

import { useState, useTransition } from 'react'
import { Plus, X, Loader2, Check } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import {
  createOrGetTemplate,
  addTemplateItem,
  removeTemplateItem,
  applyTemplateToProperty,
} from './actions'
import type { InventoryCategory } from '@/types/database'

interface TemplateItem {
  id: string
  name: string
  category: string
  unit: string
  par_level: number
  notes: string | null
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

const CATEGORY_ORDER: InventoryCategory[] = [
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other',
]

export function TemplateManager({
  template,
  properties,
  orgId,
}: {
  template: Template | null
  properties: Property[]
  orgId: string
}) {
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(template)
  const [creating, setCreating]               = useState(false)
  const [applyModal, setApplyModal]           = useState(false)
  const [selectedProps, setSelectedProps]     = useState<Set<string>>(new Set())
  const [applyResult, setApplyResult]         = useState<{ added: number; skipped: number } | null>(null)
  const [isPending, startTransition]          = useTransition()
  const [error, setError]                     = useState<string | null>(null)
  const [success, setSuccess]                 = useState<string | null>(null)

  // Add item form
  const [newName,     setNewName]     = useState('')
  const [newCategory, setNewCategory] = useState<InventoryCategory>('other')
  const [newUnit,     setNewUnit]     = useState('')
  const [newPar,      setNewPar]      = useState('1')

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
        name: newName.trim(),
        category: newCategory,
        unit: newUnit.trim(),
        par_level: parseFloat(newPar) || 1,
      })
      if (result.error) {
        setError(result.error)
      } else if (result.item) {
        setCurrentTemplate(prev => prev ? {
          ...prev,
          inventory_template_items: [...(prev.inventory_template_items ?? []), result.item!],
        } : prev)
        setNewName(''); setNewUnit(''); setNewPar('1')
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

  const handleApply = () => {
    if (!currentTemplate || selectedProps.size === 0) return
    setError(null)
    setApplyResult(null)
    startTransition(async () => {
      let totalAdded = 0, totalSkipped = 0
      for (const propId of selectedProps) {
        const result = await applyTemplateToProperty(currentTemplate.id, propId)
        if (!result.error) {
          totalAdded   += result.added
          totalSkipped += result.skipped
        }
      }
      setApplyResult({ added: totalAdded, skipped: totalSkipped })
      setSelectedProps(new Set())
      setSuccess(`Applied to ${selectedProps.size} propert${selectedProps.size !== 1 ? 'ies' : 'y'}. ${totalAdded} items added, ${totalSkipped} skipped.`)
      setTimeout(() => setSuccess(null), 5000)
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

      {/* Add item form */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide">Add Item</p>
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
