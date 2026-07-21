'use client'

import { Fragment, useState, useActionState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, ClipboardList, ChevronDown, X,
  Package, AlertTriangle, ShoppingCart, Check, History,
  BarChart2, Loader2, Save,
} from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS, formatDate } from '@/lib/utils'
import { unwrapJoinArray } from '@/lib/utils/supabase-joins'
import { updateParLevel, addInventoryItems, submitInventoryCount, approveInventoryCount, rejectInventoryCount, triggerShoppingCart } from './actions'
import type { InventoryCategory, PoStatus } from '@/types/database'
import { PortfolioInventoryView } from './portfolio-view'
import { CartReadyBanner } from '@/components/inventory/cart-ready-banner'
import { InventoryItemCard } from '@/components/inventory/inventory-item-card'
import { NudgeBanner } from '@/components/nudge-banner'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { InlineAlert } from '@/components/ui/InlineAlert'
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
  first_count_recorded_at: string | null
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
  item_id: string
  previous_quantity: number
  counted_qty: number
  notes: string | null
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
  first_count_recorded_at: string | null
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

type StockStatus = 'uncounted' | 'critical' | 'low' | 'healthy'

function getStockStatus(item: InventoryItem): StockStatus {
  if (!item.first_count_recorded_at) return 'uncounted'
  if (item.current_quantity <= item.par_level) return 'critical'
  if (item.current_quantity <= item.par_level * 1.2) return 'low'
  return 'healthy'
}

function StockBadge({ item }: { item: InventoryItem }) {
  const status = getStockStatus(item)
  if (status === 'uncounted') return <Badge tone="slate">Needs Count</Badge>
  if (status === 'critical')  return <Badge tone="red">At/Below Par</Badge>
  if (status === 'low')       return <Badge tone="amber">Low</Badge>
  return <Badge tone="green">Healthy</Badge>
}

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'purple' | 'slate'

function poBadgeTone(status: PoStatus): BadgeTone {
  const map: Record<PoStatus, BadgeTone> = {
    draft:        'slate',
    sent:         'blue',
    acknowledged: 'blue',
    ordered:      'blue',
    received:     'green',
    cancelled:    'red',
  }
  return map[status] ?? 'slate'
}

const CATEGORY_ORDER: InventoryCategory[] = [
  'paper_goods', 'cleaning', 'kitchen', 'bath', 'laundry',
  'bedroom_linens', 'outdoor', 'maintenance_safety',
  'guest_experience', 'technology', 'other',
]

// ── Inline par-level editor ───────────────────────────────────────────────────

function ParLevelEditor({ item }: { item: InventoryItem }) {
  const [editing, setEditing]     = useState(false)
  const [value, setValue]         = useState(String(item.par_level))
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!justSaved) return
    const timer = setTimeout(() => setJustSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [justSaved])

  const handleSave = async () => {
    const n = parseFloat(value)
    if (isNaN(n) || n < 0) { setError('Invalid number'); return }
    setError(null)
    setSaving(true)
    const res = await updateParLevel(item.id, n)
    setSaving(false)
    if (res.error) setError(res.error)
    else { setEditing(false); setJustSaved(true); router.refresh() }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  handleSave()
    if (e.key === 'Escape') { setEditing(false); setValue(String(item.par_level)) }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className={cn(
          'input py-0.5 px-1.5 w-14 text-sm text-right tabular-nums font-medium cursor-pointer transition-colors flex items-center justify-end gap-1',
          justSaved ? 'text-[var(--accent-green)] border-[var(--accent-green)]' : 'hover:border-[var(--border-strong)]'
        )}
        title="Click to edit par level"
      >
        {justSaved && <Check className="w-3 h-3 flex-shrink-0" />}
        {Number.isInteger(item.par_level) ? item.par_level : item.par_level.toFixed(1)}
      </button>
    )
  }

  return (
    <div
      className="relative z-10 flex items-center gap-1 p-1.5 rounded-lg"
      style={{
        background:  'var(--bg-raised)',
        border:      '1px solid var(--border-strong)',
        boxShadow:   'var(--shadow-card)',
      }}
    >
      <Input
        type="number"
        min={0}
        step={0.5}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        className="py-0.5 px-1.5 w-16 text-sm"
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
      {error && <span className="text-xs text-red-600 whitespace-nowrap">{error}</span>}
    </div>
  )
}

// ── Add Items Modal (multi-select) ────────────────────────────────────────────

type SelectedCatalogItem = {
  catalogItem: CatalogItem
  parLevel: string
  unit: string
}

const ADD_ITEMS_TABS: TabItem<'catalog' | 'custom'>[] = [
  { id: 'catalog', label: 'From Catalog' },
  { id: 'custom',  label: 'Custom Item' },
]

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
    <Dialog open onClose={onClose} title="Add Inventory Items">
      <div className="flex flex-col max-h-[90vh] -m-6">
        <Tabs
          tabs={ADD_ITEMS_TABS}
          active={tab}
          onChange={setTab}
          className="px-6 pt-6 flex-shrink-0"
        />

        {state?.error && (
          <InlineAlert tone="error" className="mx-6 mt-4 flex-shrink-0">
            {state.error}
          </InlineAlert>
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
                          <label htmlFor={`unit-${catalogItem.id}`} className="text-xs text-muted-themed block mb-1">Unit</label>
                          <Input
                            id={`unit-${catalogItem.id}`}
                            type="text"
                            value={unit}
                            onChange={(e) => updateSelected(catalogItem.id, 'unit', e.target.value)}
                            className="py-1.5 px-2 text-sm w-full"
                            placeholder="rolls, boxes, oz…"
                          />
                        </div>
                        <div>
                          <label htmlFor={`par-level-${catalogItem.id}`} className="text-xs text-muted-themed block mb-1">Par Level</label>
                          <Input
                            id={`par-level-${catalogItem.id}`}
                            type="number"
                            min={0}
                            step={0.5}
                            value={parLevel}
                            onChange={(e) => updateSelected(catalogItem.id, 'parLevel', e.target.value)}
                            className="py-1.5 px-2 text-sm w-full"
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
                <label htmlFor="custom-item-name" className="label">Item Name <span className="text-red-500">*</span></label>
                <Input
                  id="custom-item-name"
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g. Paper Towels"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="custom-category" className="label">Category</label>
                  <select
                    id="custom-category"
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
                  <label htmlFor="custom-unit" className="label">Unit <span className="text-red-500">*</span></label>
                  <Input
                    id="custom-unit"
                    type="text"
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value)}
                    placeholder="rolls, boxes, oz…"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="custom-par-level" className="label">Par Level</label>
                <Input
                  id="custom-par-level"
                  type="number"
                  min={0}
                  step={0.5}
                  value={customParLevel}
                  onChange={(e) => setCustomParLevel(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="custom-notes" className="label">Notes</label>
                <textarea
                  id="custom-notes"
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
              <Button
                type="submit"
                disabled={pending || selectedArray.length === 0}
                className="flex-1 disabled:opacity-50"
              >
                {pending
                  ? 'Adding…'
                  : selectedArray.length === 0
                  ? 'Select items above'
                  : `Add ${selectedArray.length} item${selectedArray.length !== 1 ? 's' : ''}`}
              </Button>
              <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
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
              <Button
                type="submit"
                disabled={pending || !customName.trim() || !customUnit.trim()}
                className="flex-1 disabled:opacity-50"
              >
                {pending ? 'Adding…' : 'Add Item'}
              </Button>
              <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            </form>
          )}
        </div>
      </div>
    </Dialog>
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
    <Dialog open onClose={onClose} title="Run Inventory Count" maxWidthClassName="max-w-2xl">
      <div className="max-h-[80vh] overflow-y-auto -m-6 p-6">
        <p className="text-sm text-muted-themed -mt-3 mb-4">Enter current quantities for each item</p>

        {state?.error && (
          <InlineAlert tone="error" className="mb-4">
            {state.error}
          </InlineAlert>
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
                        <label htmlFor={`count-${item.id}`} className="text-xs text-muted-themed">New Count</label>
                        <Input
                          id={`count-${item.id}`}
                          name={`item_${item.id}`}
                          type="number"
                          min={0}
                          defaultValue={item.current_quantity}
                          className="py-1 px-2 text-sm w-20 text-right"
                        />
                      </div>
                    </div>
                  ))}
                  </div>
                </div>
              </div>
            ))}

            <div>
              <label htmlFor="count-notes" className="label">Notes (optional)</label>
              <textarea
                id="count-notes"
                name="notes"
                rows={2}
                className="input resize-none"
                placeholder="Any notes about this count…"
              />
            </div>

            <div className="flex gap-3 pt-2 border-t border-themed">
              <Button type="submit" disabled={pending} className="flex-1">
                {pending ? 'Submitting…' : 'Submit Count'}
              </Button>
              <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  )
}

// ── Category rows (used in the detail modal) ──────────────────────────────────

function CategoryRows({
  category,
  items,
  pendingCounts,
  onQuantityEdit,
}: {
  category: InventoryCategory
  items: InventoryItem[]
  pendingCounts: Record<string, number>
  onQuantityEdit: (id: string, qty: number) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-1.5 px-5 py-1.5 bg-canvas-themed text-left"
        aria-expanded={!collapsed}
      >
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-themed transition-transform flex-shrink-0',
            collapsed && '-rotate-90'
          )}
        />
        <span className="text-xs font-semibold text-muted-themed uppercase tracking-wide">
          {INVENTORY_CATEGORY_LABELS[category]}
        </span>
      </button>

      {!collapsed && (
        <>
          {/* Mobile card layout */}
          <div className="md:hidden p-3 space-y-2">
            {items.map((item) => (
              <InventoryItemCard
                key={`${item.id}-${item.current_quantity}`}
                id={item.id}
                name={item.name}
                category={item.category}
                unit={item.unit}
                parLevel={item.par_level}
                currentQuantity={pendingCounts[item.id] ?? item.current_quantity}
                uncounted={!item.first_count_recorded_at}
                variant="pm"
                onQuantityChange={onQuantityEdit}
              />
            ))}
          </div>

          {/* Desktop table rows */}
          <div className="hidden md:contents">
            {items.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[1fr_72px_72px_90px_110px] gap-2 px-5 py-2.5 items-center text-sm"
                style={{
                  background: getStockStatus(item) === 'critical' ? 'var(--accent-red-dim)'
                            : getStockStatus(item) === 'low'      ? 'var(--accent-amber-dim)'
                            : undefined,
                }}
              >
                <div className="min-w-0">
                  <span className="font-medium text-primary-themed truncate block">{item.name}</span>
                  {item.notes && (
                    <span className="text-xs text-muted-themed truncate block">{item.notes}</span>
                  )}
                </div>
                <div className="text-right">
                  <Input
                    type="number"
                    min={0}
                    value={pendingCounts[item.id] ?? item.current_quantity}
                    onChange={(e) => onQuantityEdit(item.id, Math.max(0, parseInt(e.target.value, 10) || 0))}
                    aria-label={`${item.name} current count`}
                    className="py-0.5 px-1.5 w-14 text-sm text-right tabular-nums font-medium"
                  />
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
      )}
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

  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({})
  const [isSaving, startSaveTransition]   = useTransition()
  const [saveError, setSaveError]         = useState<string | null>(null)
  const [justSaved, setJustSaved]         = useState(false)

  const handleQuantityEdit = (id: string, qty: number) => {
    setJustSaved(false)
    setPendingCounts((prev) => ({ ...prev, [id]: qty }))
  }

  const handleSaveCount = () => {
    setSaveError(null)
    const formData = new FormData()
    formData.set('property_id', property.id)
    for (const item of items) {
      formData.set(`item_${item.id}`, String(pendingCounts[item.id] ?? item.current_quantity))
    }
    startSaveTransition(async () => {
      const result = await submitInventoryCount(null, formData)
      if (result.error) {
        setSaveError(result.error)
        return
      }
      setPendingCounts({})
      setJustSaved(true)
      onRefresh()
    })
  }

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
          <Button
            onClick={handleSaveCount}
            disabled={items.length === 0 || isSaving}
            className="text-xs px-3 py-1.5 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {isSaving ? 'Saving…' : justSaved ? 'Saved' : 'Save Count'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowRunCount(true)}
            disabled={items.length === 0}
            className="text-xs px-3 py-1.5 disabled:opacity-50"
          >
            <ClipboardList className="w-3.5 h-3.5" />
            Run Count
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowAddItems(true)}
            className="text-xs px-3 py-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Items
          </Button>
          <Button variant="ghost" onClick={onClose} className="p-2 ml-1">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {saveError && (
        <InlineAlert tone="error" className="mx-6 mt-4 flex-shrink-0">
          {saveError}
        </InlineAlert>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">

          {/* Inventory list */}
          <Card className="flex flex-col gap-0 p-0 overflow-hidden">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-themed gap-3">
                <Package className="w-8 h-8" />
                <div className="text-center">
                  <p className="text-sm font-medium text-secondary-themed">No inventory items yet</p>
                  <p className="text-xs text-muted-themed mt-0.5">Add items to start tracking stock levels.</p>
                </div>
                <Button onClick={() => setShowAddItems(true)} className="text-xs px-3 py-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add First Item
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <div className="divide-y divide-themed md:min-w-[480px]">
                <div className="hidden md:grid grid-cols-[1fr_72px_72px_90px_110px] gap-2 px-5 py-2 bg-canvas-themed text-xs font-medium text-muted-themed uppercase tracking-wide">
                  <span>Item</span>
                  <span className="text-right">Current</span>
                  <span className="text-right">Par</span>
                  <span className="text-right">Unit</span>
                  <span className="text-right">Status</span>
                </div>
                {byCategory.map(({ cat, catItems }) => (
                  <CategoryRows
                    key={cat}
                    category={cat}
                    items={catItems}
                    pendingCounts={pendingCounts}
                    onQuantityEdit={handleQuantityEdit}
                  />
                ))}
              </div>
              </div>
            )}
          </Card>

          {/* Prior counts */}
          <Card className="flex flex-col gap-0 p-0 overflow-hidden">
            <button
              onClick={() => setShowCounts((o) => !o)}
              className="flex items-center gap-2 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
            >
              <History className="w-3.5 h-3.5 text-muted-themed" />
              <span className="text-sm font-medium text-secondary-themed">Prior Counts</span>
              {recentCounts.length > 0 && (
                <Badge tone="slate" className="text-xs">{Math.min(recentCounts.length, 6)}</Badge>
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
          </Card>

          {/* Purchase Orders */}
          {purchaseOrders.length > 0 && (
            <Card className="flex flex-col gap-0 p-0 overflow-hidden">
              <button
                onClick={() => setShowPOs((o) => !o)}
                className="flex items-center gap-2 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
              >
                <ShoppingCart className="w-3.5 h-3.5 text-muted-themed" />
                <span className="text-sm font-medium text-secondary-themed">Purchase Orders</span>
                <Badge tone="slate" className="text-xs">{purchaseOrders.length}</Badge>
                <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', showPOs && 'rotate-180')} />
              </button>
              {showPOs && (
                <div className="border-t border-themed divide-y divide-themed">
                  {purchaseOrders.map((po) => {
                    const poItems = unwrapJoinArray(po.purchase_order_items)
                    const isExpanded = expandedPO === po.id
                    return (
                      <div key={po.id}>
                        <button
                          onClick={() => setExpandedPO(isExpanded ? null : po.id)}
                          className="flex items-center gap-3 w-full text-left px-5 py-3 hover:bg-canvas-themed transition-colors"
                        >
                          <Badge tone={poBadgeTone(po.status)}>
                            {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
                          </Badge>
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
            </Card>
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
  const criticalCount  = items.filter((i) => getStockStatus(i) === 'critical').length
  const lowCount       = items.filter((i) => getStockStatus(i) === 'low').length
  const uncountedCount = items.filter((i) => getStockStatus(i) === 'uncounted').length

  return (
    <Card className="flex flex-col gap-4 hover:shadow-card-md transition-shadow">

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
        <Badge tone="slate">{items.length} item{items.length !== 1 ? 's' : ''}</Badge>
        {criticalCount > 0 && (
          <Badge tone="red" className="flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" /> {criticalCount} critical
          </Badge>
        )}
        {lowCount > 0 && criticalCount === 0 && (
          <Badge tone="amber">{lowCount} low</Badge>
        )}
        {uncountedCount > 0 && (
          <Badge tone="slate">{uncountedCount} needs count</Badge>
        )}
        {criticalCount === 0 && lowCount === 0 && uncountedCount === 0 && items.length > 0 && (
          <Badge tone="green">All healthy</Badge>
        )}
        {items.length === 0 && (
          <span className="text-xs text-muted-themed">No items yet</span>
        )}
      </div>

      {/* Actions — matches properties page card footer */}
      <div className="flex gap-2 pt-1 border-t border-themed">
        <Button
          variant="secondary"
          onClick={onSelect}
          className="text-xs px-3 py-1.5 flex-1 justify-center"
        >
          View Inventory
        </Button>
      </div>
    </Card>
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
    <Card className="p-0 overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-themed bg-canvas-themed flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" style={{ color: 'var(--accent-amber)' }} />
        <span className="text-sm font-semibold text-primary-themed">Pending Count Review</span>
        <Badge tone="amber">{drafts.length}</Badge>
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
                      const diff = di.counted_qty - di.previous_quantity
                      return (
                        <div key={di.id} className="grid grid-cols-[1fr_80px_80px_80px] gap-2 px-4 py-2.5 border-b border-themed last:border-0 text-sm items-center">
                          <div>
                            <span className="font-medium text-primary-themed">
                              {di.inventory_items?.[0]?.name ?? '—'}
                            </span>
                            {di.inventory_items?.[0]?.unit && (
                              <span className="text-xs text-muted-themed ml-1">({di.inventory_items[0]?.unit})</span>
                            )}
                            {di.notes && (
                              <p className="text-xs text-muted-themed mt-0.5 italic">{di.notes}</p>
                            )}
                          </div>
                          <span className="text-right text-muted-themed tabular-nums">{di.previous_quantity}</span>
                          <span
                            className="text-right tabular-nums font-medium"
                            style={{
                              color: diff > 0 ? 'var(--accent-green)' : diff < 0 ? 'var(--accent-red)' : 'var(--accent-amber)',
                            }}
                          >
                            {di.counted_qty}
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
                  <Button
                    onClick={() => handleApprove(draft.id)}
                    disabled={isPending}
                    className="text-sm flex-1"
                  >
                    Approve & Commit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleReject(draft.id)}
                    disabled={isPending}
                    className="text-sm"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}

// ── Main InventoryManager ─────────────────────────────────────────────────────

type InventoryTab = 'property' | 'portfolio'

export function InventoryManager({
  properties,
  items,
  purchaseOrders,
  catalogItems,
  recentCounts,
  allInventoryItems,
  pendingDrafts,
  cartData,
  showKrogerNudge = false,
}: {
  properties: Property[]
  items: InventoryItem[]
  purchaseOrders: PurchaseOrder[]
  catalogItems: CatalogItem[]
  recentCounts: InventoryCount[]
  allInventoryItems: PortfolioItem[]
  pendingDrafts: PendingDraft[]
  cartData: (CartBuildResult & { built_at: string; location_name: string }) | null
  showKrogerNudge?: boolean
}) {
  const router = useRouter()
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InventoryTab>('property')
  const [cartPending, startCartTransition] = useTransition()
  const [cartTriggered, setCartTriggered]  = useState(false)

  const cartBuiltAtRef = useRef<string | null>(cartData?.built_at ?? null)

  useEffect(() => {
    if (!cartTriggered) return

    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      router.refresh()
      if (attempts >= 15) clearInterval(interval)
    }, 2000)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartTriggered])

  useEffect(() => {
    if (cartData?.built_at && cartData.built_at !== cartBuiltAtRef.current) {
      cartBuiltAtRef.current = cartData.built_at
      setCartTriggered(false)
    }
  }, [cartData])

  const totalItems     = items.length
  const totalCritical  = items.filter((i) => getStockStatus(i) === 'critical').length
  const totalLow       = items.filter((i) => getStockStatus(i) === 'low').length
  const totalUncounted = items.filter((i) => getStockStatus(i) === 'uncounted').length

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null

  const tabs: TabItem<InventoryTab>[] = [
    { id: 'property',  label: 'By Property', icon: <Package className="w-3.5 h-3.5" /> },
    { id: 'portfolio', label: 'Portfolio',   icon: <BarChart2 className="w-3.5 h-3.5" /> },
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
              <Badge tone="red" className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {totalCritical} critical
              </Badge>
            )}
            {totalLow > 0 && (
              <Badge tone="amber">{totalLow} low</Badge>
            )}
            {totalUncounted > 0 && (
              <Badge tone="slate">{totalUncounted} needs count</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} className="mb-5" />

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
          <Card className="text-center py-16 max-w-md mx-auto mt-4">
            <Package className="w-10 h-10 text-muted-themed mx-auto mb-3" />
            <h3 className="font-semibold text-secondary-themed mb-1">No properties yet</h3>
            <p className="text-sm text-muted-themed">Add a property to start managing inventory.</p>
          </Card>
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
            <Button
              variant="secondary"
              onClick={() => startCartTransition(async () => {
                const result = await triggerShoppingCart()
                if (result.success) setCartTriggered(true)
              })}
              disabled={cartPending}
              className="flex items-center gap-2"
            >
              {cartPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Building…</>
                : <><ShoppingCart className="w-4 h-4" /> Build Cart</>}
            </Button>
          </div>
          {cartTriggered && (
            <div className="mb-4 text-sm rounded-xl px-4 py-3 border border-themed flex items-center gap-2"
                 style={{ color: 'var(--text-muted)', background: 'var(--bg-canvas)' }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Building your Kroger cart…
            </div>
          )}
          {cartData?.status === 'nothing_below_par' && (
            <div className="mb-4 text-sm rounded-xl px-4 py-3 border border-themed" style={{ color: 'var(--text-muted)' }}>
              Nothing is currently below par — no cart needed.
            </div>
          )}
          {(cartData?.status === 'retailer_not_kroger' || cartData?.status === 'no_store_configured') && (
            <div className="mb-4 text-sm rounded-xl px-4 py-3 border"
                 style={{ color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)', borderColor: 'var(--accent-amber)' }}>
              Kroger isn&apos;t fully connected yet.{' '}
              <a href="/settings?tab=integrations" className="underline font-medium">Check your connection →</a>
            </div>
          )}
          {cartData && ['cart_added', 'list_only', 'partial'].includes(cartData.status) && (
            <CartReadyBanner cartData={cartData} />
          )}
          <PortfolioInventoryView items={allInventoryItems} />
        </>
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
