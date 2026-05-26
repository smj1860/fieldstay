'use client'

import { useState, useTransition, useActionState } from 'react'
import {
  Plus, ClipboardList, ChevronDown, ChevronRight, X,
  Package, AlertTriangle, ShoppingCart,
} from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS, formatDate } from '@/lib/utils'
import { updateParLevel, addInventoryItem, submitInventoryCount } from './actions'
import type { InventoryCategory, PoStatus } from '@/types/database'

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
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry', 'bedroom', 'outdoor', 'other',
]

// ── Inline par-level editor ───────────────────────────────────────────────────

function ParLevelEditor({ item }: { item: InventoryItem }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue]     = useState(String(item.par_level))
  const [saving, startSave]   = useTransition()
  const [error, setError]     = useState<string | null>(null)

  const handleSave = () => {
    const n = parseInt(value, 10)
    if (isNaN(n) || n < 0) { setError('Invalid number'); return }
    setError(null)
    startSave(async () => {
      const res = await updateParLevel(item.id, n)
      if (res.error) setError(res.error)
      else setEditing(false)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  handleSave()
    if (e.key === 'Escape') { setEditing(false); setValue(String(item.par_level)) }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-sm text-accent-600 hover:text-brand-700 hover:underline tabular-nums"
        title="Click to edit par level"
      >
        {item.par_level}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        className="input py-0.5 px-1.5 w-16 text-sm"
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-2 py-1 rounded bg-brand-800 text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {saving ? '…' : 'Save'}
      </button>
      <button
        onClick={() => { setEditing(false); setValue(String(item.par_level)); setError(null) }}
        className="text-xs px-2 py-1 rounded bg-accent-100 text-accent-600 hover:bg-accent-200"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({
  category,
  items,
}: {
  category: InventoryCategory
  items: InventoryItem[]
}) {
  const [open, setOpen] = useState(true)
  const criticalCount = items.filter((i) => getStockStatus(i) === 'critical').length
  const lowCount      = items.filter((i) => getStockStatus(i) === 'low').length

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left py-2 group"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-accent-400" />
          : <ChevronRight className="w-4 h-4 text-accent-400" />
        }
        <span className="text-sm font-semibold text-accent-700">
          {INVENTORY_CATEGORY_LABELS[category]}
        </span>
        <span className="badge badge-slate text-xs">{items.length}</span>
        {criticalCount > 0 && (
          <span className="badge badge-red text-xs flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" /> {criticalCount} critical
          </span>
        )}
        {lowCount > 0 && criticalCount === 0 && (
          <span className="badge badge-amber text-xs">{lowCount} low</span>
        )}
      </button>

      {open && (
        <div className="mt-1 border border-accent-200 rounded-xl overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_80px_80px_100px_120px] gap-2 px-4 py-2 bg-accent-50 border-b border-accent-200 text-xs font-medium text-accent-500 uppercase tracking-wide">
            <span>Item</span>
            <span className="text-right">Current</span>
            <span className="text-right">Par Level</span>
            <span className="text-right">Unit</span>
            <span className="text-right">Status</span>
          </div>

          {items.map((item, idx) => (
            <div
              key={item.id}
              className={cn(
                'grid grid-cols-[1fr_80px_80px_100px_120px] gap-2 px-4 py-2.5 items-center text-sm',
                idx !== items.length - 1 && 'border-b border-accent-100',
                getStockStatus(item) === 'critical' && 'bg-red-50/40',
                getStockStatus(item) === 'low'      && 'bg-amber-50/30',
              )}
            >
              <div className="min-w-0">
                <span className="font-medium text-accent-800 truncate block">{item.name}</span>
                {item.notes && (
                  <span className="text-xs text-accent-400 truncate block">{item.notes}</span>
                )}
              </div>
              <div className="text-right tabular-nums font-medium text-accent-800">
                {item.current_quantity}
              </div>
              <div className="text-right">
                <ParLevelEditor item={item} />
              </div>
              <div className="text-right text-accent-500 text-xs">{item.unit}</div>
              <div className="text-right">
                <StockBadge item={item} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Add Item Modal ────────────────────────────────────────────────────────────

function AddItemModal({
  propertyId,
  propertyItems,
  catalogItems,
  onClose,
}: {
  propertyId: string
  propertyItems: InventoryItem[]
  catalogItems: CatalogItem[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(addInventoryItem, null)
  const [tab, setTab]                       = useState<'catalog' | 'custom'>('catalog')
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(null)
  const [categoryFilter, setCategoryFilter]   = useState<InventoryCategory | 'all'>('all')

  if (state?.success) {
    onClose()
    return null
  }

  const addedCatalogIds = new Set(
    propertyItems.map((i) => i.catalog_item_id).filter(Boolean) as string[]
  )

  const visibleCatalog = catalogItems.filter((c) =>
    categoryFilter === 'all' || c.category === categoryFilter
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-card-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-accent-900">Add Inventory Item</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-accent-200">
          {(['catalog', 'custom'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setSelectedCatalog(null) }}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === t
                  ? 'border-brand-700 text-brand-800'
                  : 'border-transparent text-accent-500 hover:text-accent-700'
              )}
            >
              {t === 'catalog' ? 'From Catalog' : 'Custom Item'}
            </button>
          ))}
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        {tab === 'catalog' ? (
          <form action={action} className="space-y-4">
            <input type="hidden" name="property_id" value={propertyId} />
            {selectedCatalog && (
              <>
                <input type="hidden" name="catalog_item_id" value={selectedCatalog.id} />
                <input type="hidden" name="name" value={selectedCatalog.name} />
                <input type="hidden" name="category" value={selectedCatalog.category} />
                <input type="hidden" name="unit" value={selectedCatalog.default_unit} />
              </>
            )}

            {/* Category filter */}
            <div className="flex gap-1.5 flex-wrap">
              {(['all', ...CATEGORY_ORDER] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategoryFilter(c)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-full border transition-colors',
                    categoryFilter === c
                      ? 'bg-brand-800 text-white border-brand-800'
                      : 'bg-white text-accent-600 border-accent-200 hover:border-accent-400'
                  )}
                >
                  {c === 'all' ? 'All' : INVENTORY_CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>

            {/* Catalog list */}
            <div className="border border-accent-200 rounded-xl overflow-hidden max-h-52 overflow-y-auto">
              {visibleCatalog.map((item) => {
                const alreadyAdded = addedCatalogIds.has(item.id)
                const isSelected   = selectedCatalog?.id === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => !alreadyAdded && setSelectedCatalog(isSelected ? null : item)}
                    className={cn(
                      'w-full flex items-center justify-between px-4 py-2.5 text-left text-sm border-b border-accent-50 last:border-0 transition-colors',
                      isSelected   && 'bg-brand-800 text-white',
                      alreadyAdded && 'opacity-40 cursor-not-allowed',
                      !isSelected && !alreadyAdded && 'hover:bg-accent-50'
                    )}
                  >
                    <span className="font-medium">{item.name}</span>
                    <span className={cn('text-xs', isSelected ? 'text-brand-200' : 'text-accent-400')}>
                      {alreadyAdded ? 'Already added' : item.default_unit}
                    </span>
                  </button>
                )
              })}
            </div>

            {selectedCatalog && (
              <div>
                <label className="label">Par Level</label>
                <input name="par_level" type="number" min={1} defaultValue={1} className="input" />
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={pending || !selectedCatalog}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {pending
                  ? 'Adding…'
                  : selectedCatalog
                  ? `Add "${selectedCatalog.name}"`
                  : 'Select an item above'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            </div>
          </form>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="property_id" value={propertyId} />

            <div>
              <label className="label">Item Name <span className="text-red-500">*</span></label>
              <input name="name" type="text" required className="input" placeholder="e.g. Paper Towels" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Category</label>
                <select name="category" className="input">
                  {CATEGORY_ORDER.map((c) => (
                    <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Unit <span className="text-red-500">*</span></label>
                <input name="unit" type="text" required className="input" placeholder="rolls, boxes, oz…" />
              </div>
            </div>

            <div>
              <label className="label">Par Level</label>
              <input name="par_level" type="number" min={1} defaultValue={1} className="input" />
            </div>

            <div>
              <label className="label">Notes</label>
              <textarea name="notes" rows={2} className="input resize-none" placeholder="Any details…" />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={pending} className="btn-primary flex-1">
                {pending ? 'Adding…' : 'Add Item'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Run Count Modal ───────────────────────────────────────────────────────────

function RunCountModal({
  propertyId,
  items,
  onClose,
}: {
  propertyId: string
  items: InventoryItem[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(submitInventoryCount, null)

  if (state?.success) {
    onClose()
    return null
  }

  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, catItems: items.filter((i) => i.category === cat) }))
    .filter(({ catItems }) => catItems.length > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-8 bg-black/40 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-card-lg w-full max-w-2xl p-6 mb-8">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-semibold text-accent-900">Run Inventory Count</h3>
            <p className="text-sm text-accent-500 mt-0.5">Enter current quantities for each item</p>
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
          <div className="text-center py-10 text-accent-400">
            <Package className="w-8 h-8 mx-auto mb-2" />
            <p className="text-sm">No items to count for this property.</p>
          </div>
        ) : (
          <form action={action} className="space-y-6">
            <input type="hidden" name="property_id" value={propertyId} />

            {byCategory.map(({ cat, catItems }) => (
              <div key={cat}>
                <h4 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2">
                  {INVENTORY_CATEGORY_LABELS[cat]}
                </h4>
                <div className="border border-accent-200 rounded-xl overflow-hidden">
                  {catItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className={cn(
                        'grid grid-cols-[1fr_80px_100px_130px] gap-3 px-4 py-2.5 items-center',
                        idx !== catItems.length - 1 && 'border-b border-accent-100'
                      )}
                    >
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-accent-800 block truncate">{item.name}</span>
                        <span className="text-xs text-accent-400">{item.unit}</span>
                      </div>
                      <div className="text-right text-xs text-accent-500">
                        <span className="block">Current</span>
                        <span className="font-medium text-accent-700 tabular-nums">{item.current_quantity}</span>
                      </div>
                      <div className="text-right text-xs text-accent-500">
                        <span className="block">Par</span>
                        <span className="font-medium text-accent-700 tabular-nums">{item.par_level}</span>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <label className="text-xs text-accent-500">New Count</label>
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

            <div className="flex gap-3 pt-2 border-t border-accent-100">
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

// ── Purchase Orders Panel ─────────────────────────────────────────────────────

function PurchaseOrdersPanel({
  orders,
  propertyId,
}: {
  orders: PurchaseOrder[]
  propertyId: string
}) {
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const propertyOrders = orders.filter((o) => o.property_id === propertyId)

  return (
    <div className="mt-6 border border-accent-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left px-4 py-3 bg-accent-50 hover:bg-accent-100 transition-colors"
      >
        <ShoppingCart className="w-4 h-4 text-accent-500" />
        <span className="text-sm font-semibold text-accent-700">Purchase Orders</span>
        <span className="badge badge-slate text-xs">{propertyOrders.length}</span>
        <ChevronDown className={cn('w-4 h-4 text-accent-400 ml-auto transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="divide-y divide-accent-100">
          {propertyOrders.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-accent-400">
              No purchase orders for this property yet.
            </div>
          ) : (
            propertyOrders.map((po) => {
              const poItems = Array.isArray(po.purchase_order_items)
                ? po.purchase_order_items
                : po.purchase_order_items ? [po.purchase_order_items] : []

              const isExpanded = expandedId === po.id

              return (
                <div key={po.id}>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : po.id)}
                    className="flex items-center gap-3 w-full text-left px-4 py-3 hover:bg-accent-50 transition-colors"
                  >
                    <span className={poBadgeClass(po.status)}>
                      {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
                    </span>
                    <span className="text-sm text-accent-600">{formatDate(po.generated_at)}</span>
                    {po.total_estimated_cost != null && (
                      <span className="text-sm font-medium text-accent-800 ml-auto mr-2">
                        ${po.total_estimated_cost.toFixed(2)}
                      </span>
                    )}
                    <ChevronDown className={cn('w-3.5 h-3.5 text-accent-400 transition-transform', isExpanded && 'rotate-180')} />
                  </button>

                  {isExpanded && poItems.length > 0 && (
                    <div className="px-4 pb-3">
                      <div className="border border-accent-200 rounded-lg overflow-hidden text-xs">
                        <div className="grid grid-cols-[1fr_70px_70px_80px] gap-2 px-3 py-1.5 bg-accent-50 font-medium text-accent-500 uppercase tracking-wide">
                          <span>Item</span>
                          <span className="text-right">Current</span>
                          <span className="text-right">To Buy</span>
                          <span className="text-right">Est. Cost</span>
                        </div>
                        {poItems.map((pi) => (
                          <div
                            key={pi.id}
                            className="grid grid-cols-[1fr_70px_70px_80px] gap-2 px-3 py-1.5 border-t border-accent-100 text-accent-700"
                          >
                            <span className="truncate">{pi.item_name}</span>
                            <span className="text-right tabular-nums">{pi.current_quantity}</span>
                            <span className="text-right tabular-nums font-medium">{pi.quantity_to_buy}</span>
                            <span className="text-right tabular-nums">
                              {pi.estimated_unit_cost != null
                                ? `$${(pi.estimated_unit_cost * pi.quantity_to_buy).toFixed(2)}`
                                : '—'
                              }
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ── Main InventoryManager ─────────────────────────────────────────────────────

export function InventoryManager({
  properties,
  items,
  purchaseOrders,
  catalogItems,
}: {
  properties: Property[]
  items: InventoryItem[]
  purchaseOrders: PurchaseOrder[]
  catalogItems: CatalogItem[]
}) {
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>(
    properties[0]?.id ?? ''
  )
  const [showAddItem,    setShowAddItem]    = useState(false)
  const [showRunCount,   setShowRunCount]   = useState(false)

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId)
  const propertyItems    = items.filter((i) => i.property_id === selectedPropertyId)

  // Stats for header
  const criticalCount = propertyItems.filter((i) => getStockStatus(i) === 'critical').length
  const lowCount      = propertyItems.filter((i) => getStockStatus(i) === 'low').length

  // Group by category
  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, catItems: propertyItems.filter((i) => i.category === cat) }))
    .filter(({ catItems }) => catItems.length > 0)

  return (
    <>
      {/* Page header */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Inventory</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <p className="page-subtitle">{propertyItems.length} items</p>
            {criticalCount > 0 && (
              <span className="badge badge-red flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {criticalCount} critical
              </span>
            )}
            {lowCount > 0 && (
              <span className="badge badge-amber">{lowCount} low</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddItem(true)}
            className="btn-secondary"
            disabled={!selectedPropertyId}
          >
            <Plus className="w-4 h-4" />
            Add Item
          </button>
          <button
            onClick={() => setShowRunCount(true)}
            className="btn-primary"
            disabled={!selectedPropertyId || propertyItems.length === 0}
          >
            <ClipboardList className="w-4 h-4" />
            Run Count
          </button>
        </div>
      </div>

      {/* Property tabs */}
      {properties.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <Package className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No properties yet</h3>
          <p className="text-sm text-accent-400">Add a property to start managing inventory.</p>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-6 overflow-x-auto pb-0.5 border-b border-accent-200">
            {properties.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPropertyId(p.id)}
                className={cn(
                  'px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors',
                  selectedPropertyId === p.id
                    ? 'border-brand-700 text-brand-800'
                    : 'border-transparent text-accent-500 hover:text-accent-800 hover:border-accent-300'
                )}
              >
                <span className="max-w-[140px] truncate block">{p.name}</span>
              </button>
            ))}
          </div>

          {/* Items display */}
          {propertyItems.length === 0 ? (
            <div className="card text-center py-16 max-w-md mx-auto mt-2">
              <Package className="w-10 h-10 text-accent-300 mx-auto mb-3" />
              <h3 className="font-semibold text-accent-700 mb-1">No items yet</h3>
              <p className="text-sm text-accent-400 mb-4">
                Add inventory items to{' '}
                <span className="font-medium text-accent-600">{selectedProperty?.name}</span> to
                start tracking stock levels.
              </p>
              <button
                onClick={() => setShowAddItem(true)}
                className="btn-primary mx-auto"
              >
                <Plus className="w-4 h-4" />
                Add First Item
              </button>
            </div>
          ) : (
            <div>
              {byCategory.map(({ cat, catItems }) => (
                <CategorySection key={cat} category={cat} items={catItems} />
              ))}
            </div>
          )}

          {/* Purchase Orders panel */}
          <PurchaseOrdersPanel
            orders={purchaseOrders}
            propertyId={selectedPropertyId}
          />
        </>
      )}

      {/* Add Item modal */}
      {showAddItem && selectedPropertyId && (
        <AddItemModal
          propertyId={selectedPropertyId}
          propertyItems={propertyItems}
          catalogItems={catalogItems}
          onClose={() => setShowAddItem(false)}
        />
      )}

      {/* Run Count modal */}
      {showRunCount && selectedPropertyId && (
        <RunCountModal
          propertyId={selectedPropertyId}
          items={propertyItems}
          onClose={() => setShowRunCount(false)}
        />
      )}
    </>
  )
}
