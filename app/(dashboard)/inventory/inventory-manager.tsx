'use client'

import { Fragment, useState, useActionState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, ClipboardList, ChevronDown, X,
  Package, AlertTriangle, ShoppingCart, Check, History,
  BarChart2, FileText, Layers, Loader2,
} from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS, formatDate } from '@/lib/utils'
import { updateParLevel, addInventoryItems, submitInventoryCount, approveInventoryCount, rejectInventoryCount, triggerShoppingCart } from './actions'
import type { InventoryCategory, PoStatus } from '@/types/database'
import { PortfolioInventoryView } from './portfolio-view'
import { TemplateManager } from './template-manager'
import { CartReadyBanner } from '@/components/inventory/cart-ready-banner'
import { InventoryItemCard } from '@/components/inventory/inventory-item-card'
import { NudgeBanner } from '@/components/nudge-banner'
import type { CartBuildResult } from '@/lib/kroger/types'

// ── Local types ───────────────────────────────────────────────────────────────

interface Property { id: string; name: string; city: string | null; state: string | null }

interface InventoryItem {
  id: string
  property_id: string
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  current_quantity: number
  low_stock_threshold_pct: number
  notes: string | null
  catalog_item_id: string | null
}

interface CatalogItem {
  id: string
  name: string
  category: InventoryCategory
  default_unit: string
}

interface InventoryCount {
  id: string
  property_id: string
  submitted_at: string
  notes: string | null
}

interface DraftItem {
  id: string
  inventory_item_id: string
  previous_quantity: number
  submitted_quantity: number
  inventory_items: { name: string; unit: string }[]
}

interface PendingDraft {
  id: string
  property_id: string
  status: string
  created_at: string
  notes: string | null
  crew_members: { name: string }[] | null
  inventory_count_draft_items: DraftItem[]
}

interface PortfolioItem {
  id: string
  name: string
  category: InventoryCategory
  unit: string
  par_level: number
  current_quantity: number
  property_id: string
  preferred_brand: string | null
  property: { name: string } | null
}

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

interface PurchaseOrderItem {
  id: string
  item_name: string
  quantity_to_buy: number
  par_level: number
  current_quantity: number
  estimated_unit_cost: number | null
}

interface PurchaseOrder {
  id: string
  property_id: string
  status: PoStatus
  generated_at: string
  total_estimated_cost: number | null
  purchase_order_items: PurchaseOrderItem | PurchaseOrderItem[] | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type StockStatus = 'critical' | 'low' | 'healthy'

function getStockStatus(item: InventoryItem): StockStatus {
  if (item.current_quantity <= item.par_level) return 'critical'
  if (item.current_quantity <= item.par_level * 1.2) return 'low'
  return 'healthy'
}

function StockBadge({ item }: { item: InventoryItem }) {
  const status = getStockStatus(item)
  if (status === 'critical') return <span className="badge badge-red">At/Below Par</span>
  if (status === 'low')      return <span className="badge badge-amber">Low</span>
  return <span className="badge badge-green">Healthy</span>
}

function poBadgeClass(status: PoStatus): string {
  const map: Record<PoStatus, string> = {
    draft:        'badge badge-slate',
    sent:         'badge bg-blue-50 text-blue-700',
    acknowledged: 'badge bg-blue-50 text-blue-700',
    ordered:      'badge bg-blue-50 text-blue-700',
    received:     'badge badge-green',
    cancelled:    'badge badge-red',
  }
  return map[status] ?? 'badge badge-slate'
}

const CATEGORY_ORDER: InventoryCategory[] = [
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry',
  'bedroom_linens', 'outdoor', 'maintenance_safety',
  'guest_experience', 'technology', 'other',
]

// ── Inline par-level editor ───────────────────────────────────────────────────

function ParLevelEditor({ item }: { item: InventoryItem }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue]     = useState(String(item.par_level))
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const router = useRouter()

  const handleSave = async () => {
    const n = parseFloat(value)
    if (isNaN(n) || n < 0) { setError('Invalid number'); return }
    setError(null)
    setSaving(true)
    const res = await updateParLevel(item.id, n)
    setSaving(false)
    if (res.error) setError(res.error)
    else { setEditing(false); router.refresh() }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  handleSave()
    if (e.key === 'Escape') { setEditing(false); setValue(String(item.par_level)) }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-sm text-secondary-themed hover:text-primary-themed hover:underline tabular-nums"
        title="Click to edit par level"
      >
        {Number.isInteger(item.par_level) ? item.par_level : item.par_level.toFixed(1)}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        step={0.5}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        className="input py-0.5 px-1.5 w-16 text-sm"
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-2 py-1 rounded disabled:opacity-50"
        style={{ background: 'var(--accent-gold)', color: 'var(--bg-base)', fontWeight: 600 }}
      >
        {saving ? '…' : 'Save'}
      </button>
      <button
        onClick={() => { setEditing(false); setValue(String(item.par_level)); setError(null) }}
        className="text-xs px-2 py-1 rounded bg-raised-themed text-secondary-themed hover:bg-raised-themed"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}

// ── Add Items Modal (multi-select) ────────────────────────────────────────────

type SelectedCatalogItem = {
  catalogItem: CatalogItem
  parLevel: string
  unit: string
}

function AddItemsModal({
  propertyId,
  propertyItems,
  catalogItems,
  onClose,
  onSuccess,
}: {
  propertyId: string
  propertyItems: InventoryItem[]
  catalogItems: CatalogItem[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [state, action, pending] = useActionState(addInventoryItems, null)
  const [tab, setTab]             = useState<'catalog' | 'custom'>('catalog')
  const [categoryFilter, setCategoryFilter] = useState<InventoryCategory | 'all'>('all')
  const [selected, setSelected]   = useState<Map<string, SelectedCatalogItem>>(new Map())

  const [customName,     setCustomName]     = useState('')
  const [customCategory, setCustomCategory] = useState<InventoryCategory>('other')
  const [customUnit,     setCustomUnit]     = useState('')
  const [customParLevel, setCustomParLevel] = useState('1')
  const [customNotes,    setCustomNotes]    = useState('')

  if (state?.success) { onSuccess(); onClose(); return null }

  const addedCatalogIds = new Set(
    propertyItems.map((i) => i.catalog_item_id).filter(Boolean) as string[]
  )

  const visibleCatalog = catalogItems.filter((c) =>
    categoryFilter === 'all' || c.category === categoryFilter
  )

  const toggleItem = (item: CatalogItem) => {
    if (addedCatalogIds.has(item.id)) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(item.id)) {
        next.delete(item.id)
      } else {
        next.set(item.id, { catalogItem: item, parLevel: '1', unit: item.default_unit })
      }
      return next
    })
  }

  const updateSelected = (id: string, field: 'parLevel' | 'unit', value: string) => {
    setSelected((prev) => {
      const next = new Map(prev)
      const entry = next.get(id)
      if (entry) next.set(id, { ...entry, [field]: value })
      return next
    })
  }

  const removeSelected = (id: string) => {
    setSelected((prev) => { const next = new Map(prev); next.delete(id); return next })
  }

  const selectedArray = Array.from(selected.values())

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-lg flex flex-col max-h-[90vh]">

        <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
          <h3 className="text-lg font-semibold text-primary-themed">Add Inventory Items</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex gap-1 px-6 border-b border-themed flex-shrink-0">
          {(['catalog', 'custom'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab !== t && 'border-transparent text-muted-themed hover:text-secondary-themed'
              )}
              style={tab === t ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
            >
              {t === 'catalog' ? 'From Catalog' : 'Custom Item'}
            </button>
          ))}
        </div>

        {state?.error && (
          <div className="mx-6 mt-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 flex-shrink-0">
            {state.error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {tab === 'catalog' ? (
            <>
              <div className="flex gap-1.5 flex-wrap">
                {(['all', ...CATEGORY_ORDER] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter(c)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-full border transition-colors',
                      categoryFilter !== c && 'bg-card-themed text-secondary-themed border-themed hover:border-themed'
                    )}
                    style={categoryFilter === c ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
                  >
                    {c === 'all' ? 'All' : INVENTORY_CATEGORY_LABELS[c]}
                  </button>
                ))}
              </div>

              <div className="border border-themed rounded-xl overflow-hidden">
                {visibleCatalog.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-themed">No items in this category.</div>
                ) : visibleCatalog.map((item) => {
                  const alreadyAdded = addedCatalogIds.has(item.id)
                  const isSelected   = selected.has(item.id)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleItem(item)}
                      disabled={alreadyAdded}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm border-b border-themed last:border-0 transition-colors',
                        alreadyAdded && 'opacity-40 cursor-not-allowed',
                        !isSelected && !alreadyAdded && 'hover:bg-raised-themed',
                      )}
                      style={isSelected ? { background: 'var(--accent-amber-dim)' } : undefined}
                    >
                      <div
                        className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
                        style={{
                          background:  isSelected ? 'var(--accent-gold)' : 'transparent',
                          borderColor: isSelected ? 'var(--accent-gold)' : 'var(--border)',
                        }}
                      >
                        {isSelected && <Check className="w-3 h-3" style={{ color: 'var(--bg-base)' }} />}
                      </div>
                      <span className="flex-1 font-medium text-primary-themed">{item.name}</span>
                      <span className="text-xs text-muted-themed">
                        {alreadyAdded ? 'Already added' : item.default_unit}
                      </span>
                    </button>
                  )
                })}
              </div>

              {selectedArray.length > 0 && (
                <div className="border border-themed rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-canvas-themed border-b border-themed">
                    <span className="text-xs font-semibold text-muted-themed uppercase tracking-wide">
                      Selected — {selectedArray.length} item{selectedArray.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {selectedArray.map(({ catalogItem, parLevel, unit }) => (
                    <div key={catalogItem.id} className="px-4 py-3 border-b border-themed last:border-0 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-primary-themed truncate min-w-0">
                          {catalogItem.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeSelected(catalogItem.id)}
                          className="flex-shrink-0 text-muted-themed hover:text-red-500 p-0.5 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-muted-themed block mb-1">Unit</label>
                          <input
                            type="text"
                            value={unit}
                            onChange={(e) => updateSelected(catalogItem.id, 'unit', e.target.value)}
                            className="input py-1.5 px-2 text-sm w-full"
                            placeholder="rolls, boxes, oz…"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-themed block mb-1">Par Level</label>
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={parLevel}
                            onChange={(e) => updateSelected(catalogItem.id, 'parLevel', e.target.value)}
                            className="input py-1.5 px-2 text-sm w-full"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="label">Item Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="input"
                  placeholder="e.g. Paper Towels"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Category</label>
                  <select
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value as InventoryCategory)}
                    className="input"
                  >
                    {CATEGORY_ORDER.map((c) => (
                      <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Unit <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value)}
                    className="input"
                    placeholder="rolls, boxes, oz…"
                  />
                </div>
              </div>
              <div>
                <label className="label">Par Level</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={customParLevel}
                  onChange={(e) => setCustomParLevel(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  rows={2}
                  className="input resize-none"
                  placeholder="Any details…"
                />
              </div>
            </>
          )}
        </div>

        <div className="px-6 pb-6 pt-4 border-t border-themed flex-shrink-0">
          {tab === 'catalog' ? (
            <form action={action} className="flex gap-3">
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="item_count" value={selectedArray.length} />
              {selectedArray.map(({ catalogItem, parLevel, unit }, i) => (
                <Fragment key={catalogItem.id}>
                  <input type="hidden" name={`item_${i}_catalog_item_id`} value={catalogItem.id} />
                  <input type="hidden" name={`item_${i}_name`}           value={catalogItem.name} />
                  <input type="hidden" name={`item_${i}_category`}       value={catalogItem.category} />
                  <input type="hidden" name={`item_${i}_unit`}           value={unit} />
                  <input type="hidden" name={`item_${i}_par_level`}      value={parLevel} />
                </Fragment>
              ))}
              <button
                type="submit"
                disabled={pending || selectedArray.length === 0}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {pending
                  ? 'Adding…'
                  : selectedArray.length === 0
                  ? 'Select items above'
                  : `Add ${selectedArray.length} item${selectedArray.length !== 1 ? 's' : ''}`}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            </form>
          ) : (
            <form action={action} className="flex gap-3">
              <input type="hidden" name="property_id"        value={propertyId} />
              <input type="hidden" name="item_count"         value="1" />
              <input type="hidden" name="item_0_catalog_item_id" value="" />
              <input type="hidden" name="item_0_name"        value={customName} />
              <input type="hidden" name="item_0_category"    value={customCategory} />
              <input type="hidden" name="item_0_unit"        value={customUnit} />
              <input type="hidden" name="item_0_par_level"   value={customParLevel} />
              <input type="hidden" name="item_0_notes"       value={customNotes} />
              <button
                type="submit"
                disabled={pending || !customName.trim() || !customUnit.trim()}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {pending ? 'Adding…' : 'Add Item'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Run Count Modal ───────────────────────────────────────────────────────────

function RunCountModal({
  propertyId,
  items,
  onClose,
  onSuccess,
}: {
  propertyId: string
  items: InventoryItem[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [state, action, pending] = useActionState(submitInventoryCount, null)

  if (state?.success) { onSuccess(); onClose(); return null }

  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, catItems: items.filter((i) => i.category === cat) }))
    .filter(({ catItems }) => catItems.length > 0)

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-8 bg-black/40 overflow-y-auto">
      <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-2xl p-6 mb-8">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-semibold text-primary-themed">Run Inventory Count</h3>
            <p className="text-sm text-muted-themed mt-0.5">Enter current quantities for each item</p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        {items.length === 0 ? (
          <div className="text-center py-10 text-muted-themed">
            <Package className="w-8 h-8 mx-auto mb-2" />
            <p className="text-sm">No items to count for this property.</p>
          </div>
        ) : (
          <form action={action} className="space-y-6">
            <input type="hidden" name="property_id" value={propertyId} />

            {byCategory.map(({ cat, catItems }) => (
              <div key={cat}>
                <h4 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">
                  {INVENTORY_CATEGORY_LABELS[cat]}
                </h4>
                <div className="border border-themed rounded-xl overflow-hidden overflow-x-auto">
                  <div className="min-w-[480px]">
                  {catItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className={cn(
                        'grid grid-cols-[1fr_80px_100px_130px] gap-3 px-4 py-2.5 items-center',
                        idx !== catItems.length - 1 && 'border-b border-themed'
                      )}
                    >
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-primary-themed block truncate">{item.name}</span>
                        <span className="text-xs text-muted-themed">{item.unit}</span>
                      </div>
                      <div className="text-right text-xs text-muted-themed">
                        <span className="block">Current</span>
                        <span className="font-medium text-secondary-themed tabular-nums">{item.current_quantity}</span>
                      </div>
                      <div className="text-right text-xs text-muted-themed">
                        <span className="block">Par</span>
                        <span className="font-medium text-secondary-themed tabular-nums">
                          {Number.isInteger(item.par_level) ? item.par_level : item.par_level.toFixed(1)}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <label className="text-xs text-muted-themed">New Count</label>
                        <input
                          name={`item_${item.id}`}
                          type="number"
                          min={0}
                          defaultValue={item.current_quantity}
                          className="input py-1 px-2 text-sm w-20 text-right"
                        />
                      </div>
                    </div>
                  ))}
                  </div>
                </div>
              </div>
            ))}

            <div>
              <label className="label">Notes (optional)</label>
              <textarea
                name="notes"
                rows={2}
                className="input resize-none"
                placeholder="Any notes about this count…"
              />
            </div>

            <div className="flex gap-3 pt-2 border-t border-themed">
              <button type="submit" disabled={pending} className="btn-primary flex-1">
                {pending ? 'Submitting…' : 'Submit Count'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Category rows (used in the detail modal) ──────────────────────────────────

function CategoryRows({ category, items }: { category: InventoryCategory; items: InventoryItem[] }) {
  return (
    <>
      <div className="px-5 py-1.5 bg-canvas-themed">
        <span className="text-xs font-semibold text-muted-themed uppercase tracking-wide">
          {INVENTORY_CATEGORY_LABELS[category]}
        </span>
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden p-3 space-y-2">
        {items.map((item) => (
          <InventoryItemCard
            key={item.id}
            id={item.id}
            name={item.name}
            category={item.category}
            unit={item.unit}
            parLevel={item.par_level}
            currentQuantity={item.current_quantity}
            variant="pm"
          />
        ))}
      </div>

      {/* Desktop table rows — unchanged */}
      <div className="hidden md:contents">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'grid grid-cols-[1fr_72px_72px_90px_110px] gap-2 px-5 py-2.5 items-center text-sm',
              getStockStatus(item) === 'critical' && 'bg-red-50/40',
              getStockStatus(item) === 'low'      && 'bg-amber-50/30',
            )}
          >
            <div className="min-w-0">
              <span className="font-medium text-primary-themed truncate block">{item.name}</span>
              {item.notes && (
                <span className="text-xs text-muted-themed truncate block">{item.notes}</span>
              )}
            </div>
            <div className="text-right tabular-nums font-medium text-primary-themed">
              {item.current_quantity}
            </div>
            <div className="text-right">
              <ParLevelEditor item={item} />
            </div>
            <div className="text-right text-muted-themed text-xs">{item.unit}</div>
            <div className="text-right">
              <StockBadge item={item} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ── Property Inventory Detail Modal ───────────────────────────────────────────
// Full-screen modal containing the item table, prior counts, and POs.
// Opened by clicking "View Inventory" on the compact PropertyInventoryCard below.

function PropertyInventoryDetail({
  property,
  items,
  catalogItems,
  recentCounts,
  purchaseOrders,
  onClose,
  onRefresh,
}: {
  property: Property
  items: InventoryItem[]
  catalogItems: CatalogItem[]
  recentCounts: InventoryCount[]
  purchaseOrders: PurchaseOrder[]
  onClose: () => void
  onRefresh: () => void
}) {
  const [showAddItems, setShowAddItems] = useState(false)
  const [showRunCount, setShowRunCount] = useState(false)
  const [showCounts,   setShowCounts]   = useState(true)
  const [showPOs,      setShowPOs]      = useState(false)
  const [expandedPO,   setExpandedPO]   = useState<string | null>(null)

  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, catItems: items.filter((i) => i.category === cat) }))
    .filter(({ catItems }) => catItems.length > 0)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas-themed overflow-hidden">

      {/* Sticky header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-themed bg-card-themed flex-shrink-0">
        <div className="min-w-0">
          <h2 className="font-semibold text-primary-themed truncate">{property.name}</h2>
          {(property.city || property.state) && (
            <p className="text-xs text-muted-themed mt-0.5">
              {[property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowRunCount(true)}
            disabled={items.length === 0}
            className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
          >
            <ClipboardList className="w-3.5 h-3.5" />
            Run Count
          </button>
          <button
            onClick={() => setShowAddItems(true)}
            className="btn-secondary text-xs px-3 py-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Items
          </button>
          <button onClick={onClose} className="btn-ghost p-2 ml-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">

          {/* Inventory list */}
          <div className="card flex flex-col gap-0 p-0 overflow-hidden">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-themed gap-3">
                <Package className="w-8 h-8" />
                <div className="text-center">
                  <p className="text-sm font-medium text-secondary-themed">No inventory items yet</p>
                  <p className="text-xs text-muted-themed mt-0.5">Add items to start tracking stock levels.</p>
                </div>
                <button onClick={() => setShowAddItems(true)} className="btn-primary text-xs px-3 py-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add First Item
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <div className="divide-y divide-themed min-w-[480px]">
                <div className="hidden md:grid grid-cols-[1fr_72px_72px_90px_110px] gap-2 px-5 py-2 bg-canvas-themed text-xs font-medium text-muted-themed uppercase tracking-wide">
                  <span>Item</span>
                  <span className="text-right">Current</span>
                  <span className="text-right">Par</span>
                  <span className="text-right">Unit</span>
                  <span className="text-right">Status</span>
                </div>
                {byCategory.map(({ cat, catItems }) => (
                  <CategoryRows key={cat} category={cat} items={catItems} />
                ))}
              </div>
              </div>
            )}
          </div>

          {/* Prior counts */}
          <div className="card flex flex-col gap-0 p-0 overflow-hidden">
            <button
              onClick={() => setShowCounts((o) => !o)}
              className="flex items-center gap-2 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
            >
              <History className="w-3.5 h-3.5 text-muted-themed" />
              <span className="text-sm font-medium text-secondary-themed">Prior Counts</span>
              {recentCounts.length > 0 && (
                <span className="badge badge-slate text-xs">{Math.min(recentCounts.length, 6)}</span>
              )}
              <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', showCounts && 'rotate-180')} />
            </button>
            {showCounts && (
              recentCounts.length === 0 ? (
                <div className="px-5 py-4 text-sm text-muted-themed border-t border-themed">
                  No counts recorded yet. Use <strong>Run Count</strong> to log current quantities.
                </div>
              ) : (
                <div className="border-t border-themed">
                  <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-2 bg-canvas-themed text-xs font-medium text-muted-themed uppercase tracking-wide">
                    <span>Date</span>
                    <span>Notes</span>
                  </div>
                  <div className="divide-y divide-themed">
                    {recentCounts.slice(0, 6).map((count) => (
                      <div key={count.id} className="flex items-start justify-between gap-4 px-5 py-3">
                        <span className="text-sm font-medium text-secondary-themed whitespace-nowrap">
                          {formatDate(count.submitted_at)}
                        </span>
                        <span className="text-sm text-muted-themed text-right truncate max-w-xs">
                          {count.notes ?? '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>

          {/* Purchase Orders */}
          {purchaseOrders.length > 0 && (
            <div className="card flex flex-col gap-0 p-0 overflow-hidden">
              <button
                onClick={() => setShowPOs((o) => !o)}
                className="flex items-center gap-2 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
              >
                <ShoppingCart className="w-3.5 h-3.5 text-muted-themed" />
                <span className="text-sm font-medium text-secondary-themed">Purchase Orders</span>
                <span className="badge badge-slate text-xs">{purchaseOrders.length}</span>
                <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', showPOs && 'rotate-180')} />
              </button>
              {showPOs && (
                <div className="border-t border-themed divide-y divide-themed">
                  {purchaseOrders.map((po) => {
                    const poItems = Array.isArray(po.purchase_order_items)
                      ? po.purchase_order_items
                      : po.purchase_order_items ? [po.purchase_order_items] : []
                    const isExpanded = expandedPO === po.id
                    return (
                      <div key={po.id}>
                        <button
                          onClick={() => setExpandedPO(isExpanded ? null : po.id)}
                          className="flex items-center gap-3 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
                        >
                          <span className={poBadgeClass(po.status)}>
                            {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
                          </span>
                          <span className="text-sm text-secondary-themed">{formatDate(po.generated_at)}</span>
                          {po.total_estimated_cost != null && (
                            <span className="text-sm font-medium text-primary-themed ml-auto mr-2">
                              ${po.total_estimated_cost.toFixed(2)}
                            </span>
                          )}
                          <ChevronDown className={cn('w-3.5 h-3.5 text-muted-themed transition-transform', isExpanded && 'rotate-180')} />
                        </button>
                        {isExpanded && poItems.length > 0 && (
                          <div className="px-5 pb-3">
                            <div className="border border-themed rounded-lg overflow-hidden text-xs overflow-x-auto">
                              <div className="min-w-[320px]">
                              <div className="grid grid-cols-[1fr_70px_70px_80px] gap-2 px-3 py-1.5 bg-canvas-themed font-medium text-muted-themed uppercase tracking-wide">
                                <span>Item</span>
                                <span className="text-right">Current</span>
                                <span className="text-right">To Buy</span>
                                <span className="text-right">Est. Cost</span>
                              </div>
                              {poItems.map((pi) => (
                                <div
                                  key={pi.id}
                                  className="grid grid-cols-[1fr_70px_70px_80px] gap-2 px-3 py-1.5 border-t border-themed text-secondary-themed"
                                >
                                  <span className="truncate">{pi.item_name}</span>
                                  <span className="text-right tabular-nums">{pi.current_quantity}</span>
                                  <span className="text-right tabular-nums font-medium">{pi.quantity_to_buy}</span>
                                  <span className="text-right tabular-nums">
                                    {pi.estimated_unit_cost != null
                                      ? `$${(pi.estimated_unit_cost * pi.quantity_to_buy).toFixed(2)}`
                                      : '—'}
                                  </span>
                                </div>
                              ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sub-modals rendered at z-[60] above this z-50 modal */}
      {showAddItems && (
        <AddItemsModal
          propertyId={property.id}
          propertyItems={items}
          catalogItems={catalogItems}
          onClose={() => setShowAddItems(false)}
          onSuccess={onRefresh}
        />
      )}
      {showRunCount && (
        <RunCountModal
          propertyId={property.id}
          items={items}
          onClose={() => setShowRunCount(false)}
          onSuccess={onRefresh}
        />
      )}
    </div>
  )
}

// ── Compact Property Inventory Card ──────────────────────────────────────────
// Matches the exact visual size and layout of cards on the Properties page.
// "View Inventory" opens PropertyInventoryDetail as a full-screen modal.

function PropertyInventoryCard({
  property,
  items,
  onSelect,
}: {
  property: Property
  items: InventoryItem[]
  onSelect: () => void
}) {
  const criticalCount = items.filter((i) => getStockStatus(i) === 'critical').length
  const lowCount      = items.filter((i) => getStockStatus(i) === 'low').length

  return (
    <div className="card flex flex-col gap-4 hover:shadow-card-md transition-shadow">

      {/* Header — matches properties page card */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-primary-themed truncate">{property.name}</h3>
          {(property.city || property.state) && (
            <p className="text-sm text-muted-themed mt-0.5">
              {[property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
      </div>

      {/* Stock summary badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="badge badge-slate">{items.length} item{items.length !== 1 ? 's' : ''}</span>
        {criticalCount > 0 && (
          <span className="badge badge-red flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" /> {criticalCount} critical
          </span>
        )}
        {lowCount > 0 && criticalCount === 0 && (
          <span className="badge badge-amber">{lowCount} low</span>
        )}
        {criticalCount === 0 && lowCount === 0 && items.length > 0 && (
          <span className="badge badge-green">All healthy</span>
        )}
        {items.length === 0 && (
          <span className="text-xs text-muted-themed">No items yet</span>
        )}
      </div>

      {/* Actions — matches properties page card footer */}
      <div className="flex gap-2 pt-1 border-t border-themed">
        <button
          onClick={onSelect}
          className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"
        >
          View Inventory
        </button>
      </div>
    </div>
  )
}

// ── Pending Count Review ──────────────────────────────────────────────────────

function PendingCountReview({
  drafts,
  properties,
  onRefresh,
}: {
  drafts: PendingDraft[]
  properties: Property[]
  onRefresh: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [expanded, setExpanded]      = useState<string | null>(drafts[0]?.id ?? null)

  if (drafts.length === 0) return null

  const propName = (id: string) => properties.find(p => p.id === id)?.name ?? '—'

  const handleApprove = (draftId: string) => {
    startTransition(async () => {
      await approveInventoryCount(draftId)
      onRefresh()
    })
  }
  const handleReject = (draftId: string) => {
    startTransition(async () => {
      await rejectInventoryCount(draftId)
      onRefresh()
    })
  }

  return (
    <div className="card p-0 overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-themed bg-canvas-themed flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" style={{ color: 'var(--accent-amber)' }} />
        <span className="text-sm font-semibold text-primary-themed">Pending Count Review</span>
        <span className="badge badge-amber">{drafts.length}</span>
      </div>
      {drafts.map(draft => {
        const draftItems = draft.inventory_count_draft_items ?? []
        const isOpen = expanded === draft.id
        return (
          <div key={draft.id} className="border-b border-themed last:border-0">
            <button
              onClick={() => setExpanded(isOpen ? null : draft.id)}
              className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-canvas-themed transition-colors"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-primary-themed">{propName(draft.property_id)}</span>
                {draft.crew_members?.[0] && (
                  <span className="text-xs text-muted-themed ml-2">by {draft.crew_members[0]?.name ?? 'Unknown'}</span>
                )}
                {draft.created_at && (
                  <span className="text-xs text-muted-themed ml-2">· {formatDate(draft.created_at)}</span>
                )}
              </div>
              <span className="text-xs text-muted-themed">{draftItems.length} items</span>
              <ChevronDown className={cn('w-4 h-4 text-muted-themed transition-transform', isOpen && 'rotate-180')} />
            </button>

            {isOpen && (
              <div className="px-5 pb-4">
                <div className="border border-themed rounded-xl overflow-hidden mb-3 overflow-x-auto">
                  <div className="min-w-[400px]">
                    <div className="grid grid-cols-[1fr_80px_80px_80px] gap-2 px-4 py-2 bg-canvas-themed text-xs font-semibold text-muted-themed uppercase tracking-wide border-b border-themed">
                      <span>Item</span>
                      <span className="text-right">Previous</span>
                      <span className="text-right">Submitted</span>
                      <span className="text-right">Change</span>
                    </div>
                    {draftItems.map(di => {
                      const diff = di.submitted_quantity - di.previous_quantity
                      return (
                        <div key={di.id} className="grid grid-cols-[1fr_80px_80px_80px] gap-2 px-4 py-2.5 border-b border-themed last:border-0 text-sm items-center">
                          <div>
                            <span className="font-medium text-primary-themed">
                              {di.inventory_items?.[0]?.name ?? '—'}
                            </span>
                            {di.inventory_items?.[0]?.unit && (
                              <span className="text-xs text-muted-themed ml-1">({di.inventory_items[0]?.unit})</span>
                            )}
                          </div>
                          <span className="text-right text-muted-themed tabular-nums">{di.previous_quantity}</span>
                          <span
                            className="text-right tabular-nums font-medium"
                            style={{
                              color: diff > 0 ? 'var(--accent-green)' : diff < 0 ? 'var(--accent-red)' : 'var(--accent-amber)',
                            }}
                          >
                            {di.submitted_quantity}
                          </span>
                          <span
                            className="text-right text-xs tabular-nums"
                            style={{
                              color: diff > 0 ? 'var(--accent-green)' : diff < 0 ? 'var(--accent-red)' : 'var(--text-muted)',
                            }}
                          >
                            {diff > 0 ? `+${diff}` : diff === 0 ? '—' : String(diff)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleApprove(draft.id)}
                    disabled={isPending}
                    className="btn-primary text-sm flex-1"
                  >
                    Approve & Commit
                  </button>
                  <button
                    onClick={() => handleReject(draft.id)}
                    disabled={isPending}
                    className="btn-ghost text-sm"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main InventoryManager ─────────────────────────────────────────────────────

type InventoryTab = 'property' | 'portfolio' | 'template'

export function InventoryManager({
  properties,
  items,
  purchaseOrders,
  catalogItems,
  recentCounts,
  allInventoryItems,
  template,
  pendingDrafts,
  orgId,
  cartData,
  showKrogerNudge = false,
}: {
  properties: Property[]
  items: InventoryItem[]
  purchaseOrders: PurchaseOrder[]
  catalogItems: CatalogItem[]
  recentCounts: InventoryCount[]
  allInventoryItems: PortfolioItem[]
  template: Template | null
  pendingDrafts: PendingDraft[]
  orgId: string
  cartData: (CartBuildResult & { built_at: string; location_name: string }) | null
  showKrogerNudge?: boolean
}) {
  const router = useRouter()
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InventoryTab>('portfolio')
  const [cartPending, startCartTransition] = useTransition()
  const [cartTriggered, setCartTriggered]  = useState(false)

  const totalItems    = items.length
  const totalCritical = items.filter((i) => getStockStatus(i) === 'critical').length
  const totalLow      = items.filter((i) => getStockStatus(i) === 'low').length

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null

  const tabs: Array<{ id: InventoryTab; label: string; icon: React.ReactNode }> = [
    { id: 'property',  label: 'By Property', icon: <Package className="w-3.5 h-3.5" /> },
    { id: 'portfolio', label: 'Portfolio',   icon: <BarChart2 className="w-3.5 h-3.5" /> },
    { id: 'template',  label: 'Template',    icon: <Layers className="w-3.5 h-3.5" /> },
  ]

  return (
    <>
      {showKrogerNudge && (
        <NudgeBanner
          id="kroger-cart-intro"
          message="Below-par items can automatically build a Kroger shopping cart for same-day reordering."
          href="/settings?tab=integrations"
          linkText="Connect your store"
        />
      )}

      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Inventory</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <p className="page-subtitle">{totalItems} items across {properties.length} propert{properties.length !== 1 ? 'ies' : 'y'}</p>
            {totalCritical > 0 && (
              <span className="badge badge-red flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {totalCritical} critical
              </span>
            )}
            {totalLow > 0 && (
              <span className="badge badge-amber">{totalLow} low</span>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-5 border-b border-themed">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab !== tab.id && 'border-transparent text-muted-themed hover:text-secondary-themed'
            )}
            style={activeTab === tab.id ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Pending count reviews — show on property tab */}
      {activeTab === 'property' && pendingDrafts.length > 0 && (
        <PendingCountReview
          drafts={pendingDrafts}
          properties={properties}
          onRefresh={() => router.refresh()}
        />
      )}

      {activeTab === 'property' && (
        properties.length === 0 ? (
          <div className="card text-center py-16 max-w-md mx-auto mt-4">
            <Package className="w-10 h-10 text-muted-themed mx-auto mb-3" />
            <h3 className="font-semibold text-secondary-themed mb-1">No properties yet</h3>
            <p className="text-sm text-muted-themed">Add a property to start managing inventory.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {properties.map((p) => (
              <PropertyInventoryCard
                key={p.id}
                property={p}
                items={items.filter((i) => i.property_id === p.id)}
                onSelect={() => setSelectedPropertyId(p.id)}
              />
            ))}
          </div>
        )
      )}

      {activeTab === 'portfolio' && (
        <>
          <div className="flex justify-end mb-4">
            <button
              onClick={() => startCartTransition(async () => {
                const result = await triggerShoppingCart()
                if (result.success) setCartTriggered(true)
              })}
              disabled={cartPending}
              className="btn-secondary flex items-center gap-2"
            >
              {cartPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Building…</>
                : <><ShoppingCart className="w-4 h-4" /> Build Cart 🛒</>}
            </button>
          </div>
          {cartTriggered && !cartData && (
            <div className="mb-4 text-sm rounded-xl px-4 py-3 border border-themed"
                 style={{ color: 'var(--text-muted)', background: 'var(--bg-canvas)' }}>
              Building your Kroger cart… refresh in a moment to see the result.
            </div>
          )}
          {cartData && <CartReadyBanner cartData={cartData} />}
          <PortfolioInventoryView items={allInventoryItems} />
        </>
      )}

      {activeTab === 'template' && (
        <TemplateManager
          template={template}
          properties={properties}
          orgId={orgId}
          catalogItems={catalogItems}
        />
      )}

      {/* Full-screen detail modal for the selected property */}
      {selectedProperty && (
        <PropertyInventoryDetail
          property={selectedProperty}
          items={items.filter((i) => i.property_id === selectedProperty.id)}
          catalogItems={catalogItems}
          recentCounts={recentCounts.filter((c) => c.property_id === selectedProperty.id)}
          purchaseOrders={(purchaseOrders ?? []).filter((o) => o.property_id === selectedProperty.id)}
          onClose={() => setSelectedPropertyId(null)}
          onRefresh={() => router.refresh()}
        />
      )}
    </>
  )
}
