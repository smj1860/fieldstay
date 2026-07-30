'use client'

import { useMemo, useState, useTransition } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { upsertParLevelItems, deleteParLevelItem, cloneInventoryFromProperty } from '../actions'
import type { InventoryCategory, ParMode, ParSmartGroup } from '@/types/database'
import {
  resolvePar, PAR_SMART_GROUPS,
  type ParItemConfig, type ParPropertyContext, type ParConsumptionStats, type ParSource,
} from '@/lib/inventory/par-engine'

interface Property {
  id:              string
  name:            string
  bathrooms:       number | null
  bedrooms:        number
  max_guests:      number
  avg_stay_length: number | null
}

interface ItemRow {
  id:                 string
  property_id:        string
  catalog_item_id:    string | null
  source_template_id: string | null
  name:               string
  category:           InventoryCategory
  unit:               string
  par_level:          number
  par_mode:           ParMode
  smart_group:        ParSmartGroup | null
  base_qty:           number
  auto_adjust:        boolean
  par_resolved_at:    string | null
  preferred_brand:    string | null
}

interface CatalogItem {
  id:                 string
  name:               string
  category:           InventoryCategory
  default_unit:       string
  default_par_level:  number
  par_mode:           ParMode
  smart_group:        ParSmartGroup | null
  base_qty:           number
}

interface ConsumptionStatsRow {
  property_id:              string
  inventory_item_id:        string
  avg_rate_per_guest_night: number
  sample_count:             number
}

function propertyContext(property: Property): ParPropertyContext {
  return { bathrooms: property.bathrooms, bedrooms: property.bedrooms, max_guests: property.max_guests, avg_stay_length: property.avg_stay_length }
}

function multiplierLabel(key: 'bathrooms' | 'bedrooms' | 'max_guests'): string {
  return key === 'max_guests' ? 'guests' : key
}

interface Explained {
  par:         number
  source:      ParSource
  explanation: string
}

// The one-line "why" behind a resolved smart par — shown wherever a smart
// par renders in this editor, per the explainability requirement. Muted
// single line, never a modal.
function explainSmartPar(config: ParItemConfig, property: ParPropertyContext, stats: ParConsumptionStats | null): Explained {
  const resolved = resolvePar(config, property, stats)
  if (resolved.source === 'historical' && stats) {
    return { ...resolved, explanation: `~${stats.avg_rate_per_guest_night.toFixed(2)}/guest-night over ${stats.sample_count} counts + 20% buffer` }
  }
  if (resolved.source === 'smart_formula' && config.smart_group) {
    const spec = PAR_SMART_GROUPS[config.smart_group]
    return { ...resolved, explanation: `${config.base_qty} × ${multiplierLabel(spec.multiplierKey)} + ${Math.round(spec.buffer * 100)}% buffer` }
  }
  return { ...resolved, explanation: '' }
}

function SourceBadge({ source }: Readonly<{ source: ParSource }>) {
  if (source === 'historical') return <Badge tone="blue">Auto (usage)</Badge>
  if (source === 'smart_formula') return <Badge tone="gold">Auto (formula)</Badge>
  return null
}

function labelForProperty(items: ItemRow[], templateNameById: Record<string, string>): { label: string; tone: 'green' | 'amber' | 'slate' } {
  if (items.length === 0) return { label: 'No items yet', tone: 'slate' }
  const templateIds = new Set(items.map((i) => i.source_template_id))
  if (templateIds.size === 1) {
    const [only] = templateIds
    if (only) return { label: templateNameById[only] ?? 'Unknown template', tone: 'green' }
  }
  return { label: 'Mixed', tone: 'amber' }
}

export function ParLevelsBrowser({
  properties,
  items,
  templateNameById,
  catalogItems,
  consumptionStats,
  canManage,
}: Readonly<{
  properties:       Property[]
  items:            ItemRow[]
  templateNameById: Record<string, string>
  catalogItems:     CatalogItem[]
  consumptionStats: ConsumptionStatsRow[]
  canManage:        boolean
}>) {
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null)
  const [liveItems, setLiveItems] = useState<ItemRow[]>(items)

  const itemsByProperty = useMemo(() => {
    const map: Record<string, ItemRow[]> = {}
    for (const item of liveItems) {
      const bucket = map[item.property_id] ?? []
      bucket.push(item)
      map[item.property_id] = bucket
    }
    return map
  }, [liveItems])

  const editingProperty = properties.find((p) => p.id === editingPropertyId) ?? null

  if (properties.length === 0) {
    return <p className="text-sm text-muted-themed">No active properties yet.</p>
  }

  return (
    <>
      <Card className="divide-y divide-themed p-0 overflow-hidden">
        {properties.map((property) => {
          const propertyItems = itemsByProperty[property.id] ?? []
          const { label, tone } = labelForProperty(propertyItems, templateNameById)
          return (
            <button
              key={property.id}
              type="button"
              onClick={() => setEditingPropertyId(property.id)}
              className="w-full flex items-center justify-between gap-4 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-primary-themed">{property.name}</p>
                <p className="text-xs text-muted-themed mt-0.5">{propertyItems.length} item{propertyItems.length !== 1 ? 's' : ''}</p>
              </div>
              <Badge tone={tone}>{label}</Badge>
            </button>
          )
        })}
      </Card>

      {editingProperty && (
        <PropertyParLevelEditor
          property={editingProperty}
          items={itemsByProperty[editingProperty.id] ?? []}
          catalogItems={catalogItems}
          consumptionStats={consumptionStats.filter((s) => s.property_id === editingProperty.id)}
          otherProperties={properties.filter((p) => p.id !== editingProperty.id)}
          canManage={canManage}
          onClose={() => setEditingPropertyId(null)}
          onItemsChange={(nextForProperty) => {
            setLiveItems((prev) => [
              ...prev.filter((i) => i.property_id !== editingProperty.id),
              ...nextForProperty,
            ])
          }}
        />
      )}
    </>
  )
}

interface EditableRow extends ItemRow {
  isNew?: boolean
  isDirty?: boolean
}

function PropertyParLevelEditor({
  property,
  items,
  catalogItems,
  consumptionStats,
  otherProperties,
  canManage,
  onClose,
  onItemsChange,
}: Readonly<{
  property:         Property
  items:            ItemRow[]
  catalogItems:     CatalogItem[]
  consumptionStats: ConsumptionStatsRow[]
  otherProperties:  Property[]
  canManage:        boolean
  onClose:          () => void
  onItemsChange:   (items: ItemRow[]) => void
}>) {
  const [rows, setRows] = useState<EditableRow[]>(items.map((i) => ({ ...i })))
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customCategory, setCustomCategory] = useState<InventoryCategory>('other')
  const [customUnit, setCustomUnit] = useState('units')

  const [cloneSource, setCloneSource] = useState('')
  const [cloning, startClone] = useTransition()

  const addedCatalogIds = new Set(rows.map((r) => r.catalog_item_id).filter(Boolean))
  const catalogById = useMemo(() => new Map(catalogItems.map((c) => [c.id, c])), [catalogItems])
  const statsByItemId = useMemo(
    () => new Map(consumptionStats.map((s) => [s.inventory_item_id, { avg_rate_per_guest_night: s.avg_rate_per_guest_night, sample_count: s.sample_count }])),
    [consumptionStats]
  )

  const updateRow = (id: string, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch, isDirty: true } : r)))
  }

  const removeRow = (row: EditableRow) => {
    startSave(async () => {
      if (!row.isNew) {
        const result = await deleteParLevelItem(row.id)
        if (result.error) { setError(result.error); return }
      }
      const next = rows.filter((r) => r.id !== row.id)
      setRows(next)
      onItemsChange(next)
    })
  }

  const addFromCatalog = (catalogItem: CatalogItem) => {
    setRows((prev) => [...prev, {
      id:                 `new-${catalogItem.id}`,
      property_id:        property.id,
      catalog_item_id:    catalogItem.id,
      source_template_id: null,
      name:               catalogItem.name,
      category:           catalogItem.category,
      unit:               catalogItem.default_unit,
      par_level:          catalogItem.default_par_level,
      // Inherited from the catalog row — the formula preview against this
      // property's real metadata renders immediately below.
      par_mode:           catalogItem.par_mode,
      smart_group:        catalogItem.smart_group,
      base_qty:           catalogItem.base_qty,
      auto_adjust:        true,
      par_resolved_at:    null,
      preferred_brand:    null,
      isNew:              true,
      isDirty:            true,
    }])
  }

  const addCustom = () => {
    const trimmed = customName.trim()
    if (!trimmed) return
    setRows((prev) => [...prev, {
      id:                 `new-custom-${Date.now()}-${prev.length}`,
      property_id:        property.id,
      catalog_item_id:    null,
      source_template_id: null,
      name:               trimmed,
      category:           customCategory,
      unit:               customUnit.trim() || 'units',
      par_level:          1,
      // No catalog row to inherit from — a freeform custom item always
      // starts static.
      par_mode:           'static',
      smart_group:        null,
      base_qty:           1,
      auto_adjust:        true,
      par_resolved_at:    null,
      preferred_brand:    null,
      isNew:              true,
      isDirty:            true,
    }])
    setCustomName('')
    setShowCustomForm(false)
  }

  const dirtyRows = rows.filter((r) => r.isDirty)

  const handleSave = () => {
    if (dirtyRows.length === 0) return
    // Server processes existing-vs-new in that order and returns saved
    // rows in the same two blocks — splitting dirtyRows the identical way
    // here lets the response be matched back positionally within each
    // block, which is the only way a brand-new row's real id (the
    // client-side placeholder is never a real id) makes it back into
    // local state. See upsertParLevelItems' doc comment.
    const dirtyExisting = dirtyRows.filter((r) => !r.isNew)
    const dirtyNew      = dirtyRows.filter((r) => r.isNew)
    startSave(async () => {
      setError(null)
      const result = await upsertParLevelItems(
        property.id,
        [...dirtyExisting, ...dirtyNew].map((r) => ({
          id:              r.isNew ? undefined : r.id,
          catalog_item_id: r.catalog_item_id,
          name:            r.name,
          category:        r.category,
          unit:            r.unit,
          par_level:       r.par_level,
          par_mode:        r.par_mode,
          smart_group:     r.smart_group,
          base_qty:        r.base_qty,
          auto_adjust:     r.auto_adjust,
          preferred_brand: r.preferred_brand,
        }))
      )
      if (result.error || !result.items) { setError(result.error ?? 'Operation failed. Please try again.'); return }

      const savedById = new Map<string, ItemRow>()
      dirtyExisting.forEach((r, i) => { const saved = result.items![i]; if (saved) savedById.set(r.id, saved) })
      dirtyNew.forEach((r, i) => { const saved = result.items![dirtyExisting.length + i]; if (saved) savedById.set(r.id, saved) })

      const cleaned: EditableRow[] = rows.map((r) => {
        const saved = savedById.get(r.id)
        return saved ? { ...saved, isDirty: false, isNew: false } : { ...r, isDirty: false, isNew: false }
      })
      setRows(cleaned)
      onItemsChange(cleaned)
    })
  }

  const handleClone = () => {
    if (!cloneSource) return
    startClone(async () => {
      setError(null)
      const result = await cloneInventoryFromProperty(cloneSource, property.id)
      if (result.error) { setError(result.error); return }
      // Cloned rows were written server-side — the simplest correct way
      // to reflect them here is to close and let the page's next load
      // (revalidatePath already fires inside cloneInventoryFromProperty)
      // show the real state, rather than guessing at what got inserted.
      onClose()
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={property.name}
      maxWidthClassName="max-w-2xl"
      mobileSheet
      footer={canManage ? (
        <Button onClick={handleSave} disabled={saving || dirtyRows.length === 0}>
          {saving ? 'Saving…' : `Save ${dirtyRows.length || ''} change${dirtyRows.length === 1 ? '' : 's'}`}
        </Button>
      ) : undefined}
    >
      <div className="space-y-4">
        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        {rows.length === 0 && otherProperties.length > 0 && canManage && (
          <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-4 border border-themed" style={{ background: 'var(--bg-raised)' }}>
            <div>
              <p className="text-sm font-semibold text-primary-themed">Copy from another property</p>
              <p className="text-xs text-muted-themed mt-0.5">Items already here would be skipped anyway.</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={cloneSource} onChange={(e) => setCloneSource(e.target.value)} className="input text-sm">
                <option value="">Select a property…</option>
                {otherProperties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Button variant="secondary" onClick={handleClone} disabled={!cloneSource || cloning} className="text-xs whitespace-nowrap">
                {cloning ? 'Cloning…' : 'Clone'}
              </Button>
            </div>
          </div>
        )}

        <div className="border border-themed rounded-lg divide-y divide-themed max-h-80 overflow-y-auto">
          {rows.map((row) => (
            <ParLevelRow
              key={row.id}
              row={row}
              property={property}
              stats={statsByItemId.get(row.id) ?? null}
              catalogItem={row.catalog_item_id ? catalogById.get(row.catalog_item_id) : undefined}
              canManage={canManage}
              saving={saving}
              onUpdate={(patch) => updateRow(row.id, patch)}
              onRemove={() => removeRow(row)}
            />
          ))}
          {rows.length === 0 && (
            <p className="text-sm text-muted-themed px-3 py-3">No items on this property yet.</p>
          )}
        </div>

        {canManage && (
          <>
            <div>
              <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">Add from Master List</p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {catalogItems.filter((c) => !addedCatalogIds.has(c.id)).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => addFromCatalog(c)}
                    className="text-xs px-2.5 py-1 rounded-full border border-themed text-secondary-themed hover:text-[var(--accent-gold)] hover:border-[var(--accent-gold)] transition-colors"
                  >
                    <Plus className="w-3 h-3 inline mr-1" />{c.name}
                  </button>
                ))}
              </div>
            </div>

            {showCustomForm ? (
              <div className="border border-themed rounded-xl p-3 flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1">
                  <label htmlFor={`custom-item-${property.id}`} className="text-xs font-medium text-secondary-themed">Item name</label>
                  <input
                    id={`custom-item-${property.id}`}
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }}
                    className="input mt-1 w-full text-sm"
                  />
                </div>
                <select value={customCategory} onChange={(e) => setCustomCategory(e.target.value as InventoryCategory)} className="input text-sm">
                  {(Object.entries(INVENTORY_CATEGORY_LABELS) as [InventoryCategory, string][]).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
                <input value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="units" className="input text-sm w-24" />
                <Button onClick={addCustom} disabled={!customName.trim()} className="text-sm whitespace-nowrap">Add</Button>
                <Button variant="ghost" onClick={() => setShowCustomForm(false)} className="text-sm">Cancel</Button>
              </div>
            ) : (
              <Button variant="secondary" onClick={() => setShowCustomForm(true)} className="text-sm inline-flex items-center gap-1.5 w-full justify-center border-dashed">
                <Plus className="w-4 h-4" /> Add Custom Item
              </Button>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

function ParLevelRow({
  row,
  property,
  stats,
  catalogItem,
  canManage,
  saving,
  onUpdate,
  onRemove,
}: Readonly<{
  row:         EditableRow
  property:    Property
  stats:       ParConsumptionStats | null
  catalogItem: CatalogItem | undefined
  canManage:   boolean
  saving:      boolean
  onUpdate:    (patch: Partial<EditableRow>) => void
  onRemove:    () => void
}>) {
  const config: ParItemConfig = {
    par_mode:    row.par_mode,
    smart_group: row.smart_group,
    base_qty:    row.base_qty,
    par_level:   row.par_level,
    auto_adjust: row.auto_adjust,
  }
  const explained = row.par_mode === 'smart' ? explainSmartPar(config, propertyContext(property), stats) : null
  const canRevertToSmart = row.par_mode === 'static' && catalogItem?.par_mode === 'smart'

  const handleOverride = () => {
    onUpdate({ par_mode: 'static', smart_group: null, par_level: explained?.par ?? row.par_level })
  }

  const handleRevertToSmart = () => {
    if (!catalogItem) return
    onUpdate({ par_mode: 'smart', smart_group: catalogItem.smart_group, base_qty: catalogItem.base_qty })
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-primary-themed flex-1 min-w-[80px] truncate">{row.name}</span>
        <span className="text-xs text-muted-themed">{INVENTORY_CATEGORY_LABELS[row.category] ?? row.category}</span>
        {canManage ? (
          <>
            {row.par_mode === 'smart' ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-themed">Par:</span>
                <span className="text-sm text-primary-themed font-medium">{explained?.par}</span>
                {explained && <SourceBadge source={explained.source} />}
                <Button variant="ghost" onClick={handleOverride} className="text-xs px-1.5 py-0.5 whitespace-nowrap">Override</Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-themed">Par:</span>
                <input
                  type="number" min="0" step="0.5" value={row.par_level}
                  onChange={(e) => onUpdate({ par_level: Math.max(0, parseFloat(e.target.value) || 0) })}
                  aria-label={`Par level for ${row.name}`}
                  className="w-14 text-center text-sm border border-themed rounded px-1 py-0.5 bg-transparent text-primary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
                />
                {canRevertToSmart && (
                  <Button variant="ghost" onClick={handleRevertToSmart} className="text-xs px-1.5 py-0.5 whitespace-nowrap">Revert to smart</Button>
                )}
              </div>
            )}
            <input
              value={row.unit}
              onChange={(e) => onUpdate({ unit: e.target.value })}
              aria-label={`Unit for ${row.name}`}
              className="w-16 text-xs border border-themed rounded px-1 py-0.5 bg-transparent text-secondary-themed focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
            />
            <input
              value={row.preferred_brand ?? ''}
              onChange={(e) => onUpdate({ preferred_brand: e.target.value || null })}
              placeholder="Brand"
              aria-label={`Preferred brand for ${row.name}`}
              className="w-24 text-xs border border-themed rounded px-1.5 py-0.5 bg-transparent text-secondary-themed placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)]"
            />
            <button type="button" onClick={onRemove} disabled={saving} className="text-muted-themed hover:text-[var(--accent-red)] transition-colors p-1">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <span className="text-xs text-muted-themed">
            Par {row.par_mode === 'smart' ? explained?.par : row.par_level} {row.unit}{row.preferred_brand && <> · {row.preferred_brand}</>}
          </span>
        )}
      </div>
      {row.par_mode === 'smart' && canManage && (
        <label className="flex items-center gap-1.5 text-xs text-muted-themed cursor-pointer w-fit">
          <Checkbox checked={row.auto_adjust} onChange={() => onUpdate({ auto_adjust: !row.auto_adjust })} />
          Auto-adjust from usage
        </label>
      )}
      {row.par_mode === 'smart' && explained?.explanation && (
        <p className="text-xs text-muted-themed">{explained.explanation}</p>
      )}
    </div>
  )
}
