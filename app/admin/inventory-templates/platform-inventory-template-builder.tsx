'use client'

import { useMemo, useState, useTransition } from 'react'
import { Plus, Trash2, ChevronRight, Check, Package, Radio as RadioIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import type { InventoryCategory } from '@/types/database'
import {
  createPlatformInventoryTemplate,
  renamePlatformInventoryTemplate,
  deletePlatformInventoryTemplate,
  savePlatformInventoryTemplateItems,
  broadcastPlatformInventoryTemplate,
  listOrgsForBroadcast,
  type PlatformTemplateItemInput,
  type BroadcastTarget,
} from './actions'

interface CatalogItem {
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
}

interface ItemState {
  tempId:          string
  catalog_item_id: string
  par_level:       number
  preferred_brand: string
}

interface TemplateState {
  id:          string
  name:        string
  description: string
  items:       ItemState[]
}

function makeId() {
  if (typeof globalThis.window === 'undefined') return 'ssr'
  return crypto.randomUUID()
}

function toItemState(item: { catalog_item_id: string; par_level: number; preferred_brand: string }): ItemState {
  return { tempId: makeId(), catalog_item_id: item.catalog_item_id, par_level: item.par_level, preferred_brand: item.preferred_brand }
}

function renameTemplateInList(templates: TemplateState[], id: string, field: 'name' | 'description', value: string): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, [field]: value } : t))
}

function addItemToTemplate(templates: TemplateState[], id: string, catalogItemId: string): TemplateState[] {
  return templates.map((t) =>
    t.id === id
      ? { ...t, items: [...t.items, { tempId: makeId(), catalog_item_id: catalogItemId, par_level: 1, preferred_brand: '' }] }
      : t
  )
}

function removeItemFromTemplate(templates: TemplateState[], id: string, itemTempId: string): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, items: t.items.filter((i) => i.tempId !== itemTempId) } : t))
}

function updateItemInTemplate(templates: TemplateState[], id: string, itemTempId: string, field: keyof ItemState, value: unknown): TemplateState[] {
  return templates.map((t) =>
    t.id === id
      ? { ...t, items: t.items.map((i) => (i.tempId === itemTempId ? { ...i, [field]: value } : i)) }
      : t
  )
}

function removeTemplateFromList(templates: TemplateState[], id: string): TemplateState[] {
  return templates.filter((t) => t.id !== id)
}

function buildItemsPayload(items: ItemState[]): PlatformTemplateItemInput[] {
  return items.map((item, i) => ({
    catalog_item_id: item.catalog_item_id,
    par_level:       item.par_level,
    preferred_brand: item.preferred_brand,
    sort_order:      i,
  }))
}

function saveButtonLabel(saving: boolean, saved: boolean) {
  if (saving) return 'Saving…'
  if (saved) return <><Check className="w-4 h-4" /> Saved</>
  return 'Save Items'
}

export function PlatformInventoryTemplateBuilder({
  initialTemplates,
  catalogItems,
}: Readonly<{
  initialTemplates: Array<{ id: string; name: string; description: string; items: Array<{ id: string; catalog_item_id: string; par_level: number; preferred_brand: string }> }>
  catalogItems: CatalogItem[]
}>) {
  const [templates, setTemplates] = useState<TemplateState[]>(() =>
    initialTemplates.map((t) => ({ id: t.id, name: t.name, description: t.description, items: t.items.map(toItemState) }))
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newTemplateName, setNewTemplateName] = useState('')
  const [creating, startCreate] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null)

  const catalogById = useMemo(() => new Map(catalogItems.map((c) => [c.id, c])), [catalogItems])

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreateTemplate = () => {
    const name = newTemplateName.trim()
    if (!name) return
    startCreate(async () => {
      const result = await createPlatformInventoryTemplate(name, '')
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to create template.')
        return
      }
      setTemplates((prev) => [...prev, { id: result.id!, name, description: '', items: [] }])
      setExpanded((prev) => new Set(prev).add(result.id!))
      setNewTemplateName('')
      setError(null)
    })
  }

  const updateTemplateField = (id: string, field: 'name' | 'description', value: string) => {
    setTemplates((prev) => renameTemplateInList(prev, id, field, value))
  }

  const addItem = (id: string, catalogItemId: string) => {
    if (!catalogItemId) return
    setTemplates((prev) => addItemToTemplate(prev, id, catalogItemId))
  }

  const removeItem = (id: string, itemTempId: string) => {
    setTemplates((prev) => removeItemFromTemplate(prev, id, itemTempId))
  }

  const updateItem = (id: string, itemTempId: string, field: keyof ItemState, value: unknown) => {
    setTemplates((prev) => updateItemInTemplate(prev, id, itemTempId, field, value))
  }

  const handleSaveTemplate = (template: TemplateState, fieldsChanged: boolean) => {
    startCreate(async () => {
      setError(null)
      if (fieldsChanged) {
        const renameResult = await renamePlatformInventoryTemplate(template.id, template.name, template.description)
        if (renameResult.error) { setError(renameResult.error); return }
      }
      const itemsResult = await savePlatformInventoryTemplateItems(template.id, buildItemsPayload(template.items))
      if (itemsResult.error) { setError(itemsResult.error); return }
      setSavedTemplateId(template.id)
      setTimeout(() => setSavedTemplateId(null), 2000)
    })
  }

  const handleDeleteTemplate = (id: string) => {
    startCreate(async () => {
      setError(null)
      const result = await deletePlatformInventoryTemplate(id)
      if (result.error) { setError(result.error); return }
      setTemplates((prev) => removeTemplateFromList(prev, id))
    })
  }

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {templates.length === 0 && (
        <div className="border border-dashed border-themed rounded-xl p-8 text-center">
          <Package className="w-6 h-6 mx-auto mb-2 text-muted-themed" />
          <p className="text-sm text-muted-themed">
            No platform templates yet. Create one — e.g. &quot;Standard
            FieldStay Inventory Template&quot; — then add items and broadcast it.
          </p>
        </div>
      )}

      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          isOpen={expanded.has(template.id)}
          saved={savedTemplateId === template.id}
          saving={creating}
          catalogItems={catalogItems}
          catalogById={catalogById}
          onToggle={() => toggleExpanded(template.id)}
          onFieldChange={(field, value) => updateTemplateField(template.id, field, value)}
          onAddItem={(catalogItemId) => addItem(template.id, catalogItemId)}
          onRemoveItem={(itemTempId) => removeItem(template.id, itemTempId)}
          onUpdateItem={(itemTempId, field, value) => updateItem(template.id, itemTempId, field, value)}
          onSave={(fieldsChanged) => handleSaveTemplate(template, fieldsChanged)}
          onDelete={() => handleDeleteTemplate(template.id)}
          setError={setError}
        />
      ))}

      <div className="flex gap-2">
        <input
          value={newTemplateName}
          onChange={(e) => setNewTemplateName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTemplate() }}
          placeholder="New template name — e.g. Standard FieldStay Inventory Template"
          className="input flex-1 text-sm"
        />
        <Button
          variant="secondary"
          onClick={handleCreateTemplate}
          disabled={creating || !newTemplateName.trim()}
          className="inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Add Template
        </Button>
      </div>
    </div>
  )
}

function TemplateCard({
  template,
  isOpen,
  saved,
  saving,
  catalogItems,
  catalogById,
  onToggle,
  onFieldChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  onSave,
  onDelete,
  setError,
}: Readonly<{
  template: TemplateState
  isOpen: boolean
  saved: boolean
  saving: boolean
  catalogItems: CatalogItem[]
  catalogById: Map<string, CatalogItem>
  onToggle: () => void
  onFieldChange: (field: 'name' | 'description', value: string) => void
  onAddItem: (catalogItemId: string) => void
  onRemoveItem: (itemTempId: string) => void
  onUpdateItem: (itemTempId: string, field: keyof ItemState, value: unknown) => void
  onSave: (fieldsChanged: boolean) => void
  onDelete: () => void
  setError: (msg: string | null) => void
}>) {
  const [initialName]        = useState(template.name)
  const [initialDescription] = useState(template.description)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pickerValue, setPickerValue] = useState('')

  const addedCatalogItemIds = useMemo(() => new Set(template.items.map((i) => i.catalog_item_id)), [template.items])
  const availableCatalogItems = useMemo(
    () => catalogItems.filter((c) => !addedCatalogItemIds.has(c.id)),
    [catalogItems, addedCatalogItemIds]
  )

  return (
    <div className="border border-themed rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
      >
        <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform text-muted-themed ${isOpen ? 'rotate-90' : ''}`} />
        <span className="text-sm font-semibold text-primary-themed flex-1">{template.name}</span>
        <span className="text-xs text-muted-themed">{template.items.length} item{template.items.length !== 1 ? 's' : ''}</span>
      </button>

      {isOpen && (
        <div className="border-t border-themed px-4 py-4 space-y-4">
          <div className="space-y-2">
            <input
              value={template.name}
              onChange={(e) => onFieldChange('name', e.target.value)}
              className="input w-full text-sm font-medium"
              placeholder="Template name"
            />
            <input
              value={template.description}
              onChange={(e) => onFieldChange('description', e.target.value)}
              className="input w-full text-sm"
              placeholder="Description (optional)"
            />
          </div>

          <div className="divide-y divide-themed border border-themed rounded-lg overflow-hidden">
            {template.items.map((item) => {
              const catalog = catalogById.get(item.catalog_item_id)
              return (
                <div key={item.tempId} className="flex items-center gap-2 px-3 py-2 group hover:bg-raised-themed">
                  <span className="flex-1 text-sm text-primary-themed truncate">
                    {catalog?.name ?? 'Unknown item'}
                    <span className="text-xs text-muted-themed ml-1">
                      ({catalog ? INVENTORY_CATEGORY_LABELS[catalog.category] : '—'})
                    </span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={item.par_level}
                    onChange={(e) => onUpdateItem(item.tempId, 'par_level', Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 1)}
                    className="input text-sm w-20"
                    aria-label="Par level"
                    title="Par level"
                  />
                  <input
                    value={item.preferred_brand}
                    onChange={(e) => onUpdateItem(item.tempId, 'preferred_brand', e.target.value)}
                    placeholder="Preferred brand"
                    className="input text-sm w-36"
                    aria-label="Preferred brand"
                  />
                  <Button variant="ghost" onClick={() => onRemoveItem(item.tempId)} className="p-1 text-muted-themed hover:text-[var(--accent-red)]">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )
            })}
            {template.items.length === 0 && (
              <p className="px-3 py-4 text-xs text-center text-muted-themed">No items yet — add from the catalog below.</p>
            )}
          </div>

          <div className="flex gap-2">
            <select
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
              className="input text-sm flex-1"
              aria-label="Add catalog item"
            >
              <option value="">Select an item to add…</option>
              {availableCatalogItems.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({INVENTORY_CATEGORY_LABELS[c.category]})</option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={() => { onAddItem(pickerValue); setPickerValue('') }}
              disabled={!pickerValue}
              className="inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Add
            </Button>
          </div>

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <Button
              variant="secondary"
              onClick={() => onSave(template.name !== initialName || template.description !== initialDescription)}
              disabled={saving}
              className="text-sm inline-flex items-center gap-1.5"
            >
              {saveButtonLabel(saving, saved)}
            </Button>

            {confirmDelete ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-themed">Delete this template?</span>
                <Button variant="secondary" onClick={onDelete} disabled={saving} className="text-xs" style={{ color: 'var(--accent-red)' }}>
                  Yes, delete
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="text-xs">Cancel</Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
                className="text-sm ml-auto text-muted-themed hover:text-[var(--accent-red)]"
              >
                Delete Template
              </Button>
            )}
          </div>

          <BroadcastPanel templateId={template.id} setError={setError} />
        </div>
      )}
    </div>
  )
}

function BroadcastPanel({
  templateId,
  setError,
}: Readonly<{
  templateId: string
  setError: (msg: string | null) => void
}>) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null)
  const [loadingOrgs, setLoadingOrgs] = useState(false)
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set())
  const [dispatching, startDispatch] = useTransition()
  const [dispatched, setDispatched] = useState(false)

  async function handleOpen() {
    setOpen(true)
    setDispatched(false)
    if (orgs !== null) return
    setLoadingOrgs(true)
    const result = await listOrgsForBroadcast()
    setLoadingOrgs(false)
    if (result.error) { setError(result.error); return }
    setOrgs(result.orgs ?? [])
  }

  function toggleOrg(id: string) {
    setSelectedOrgIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleBroadcast() {
    const target: BroadcastTarget = mode === 'all' ? { mode: 'all' } : { mode: 'selected', orgIds: [...selectedOrgIds] }
    startDispatch(async () => {
      setError(null)
      const result = await broadcastPlatformInventoryTemplate(templateId, target)
      if (result.error) { setError(result.error); return }
      setDispatched(true)
    })
  }

  if (!open) {
    return (
      <div className="pt-2 border-t border-themed">
        <Button variant="ghost" onClick={handleOpen} className="text-sm inline-flex items-center gap-1.5">
          <RadioIcon className="w-3.5 h-3.5" /> Broadcast to Accounts
        </Button>
      </div>
    )
  }

  return (
    <div className="pt-3 border-t border-themed space-y-3">
      <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Broadcast to Accounts</h4>
      <p className="text-xs text-muted-themed">
        Adds any items on this template that a targeted account doesn&apos;t
        already have. Existing items and any customizations an account has
        already made are left untouched.
      </p>

      <div className="flex items-center gap-4 text-sm">
        <label htmlFor={`broadcast-all-${templateId}`} className="flex items-center gap-1.5 cursor-pointer">
          <input
            id={`broadcast-all-${templateId}`}
            type="radio"
            name={`broadcast-mode-${templateId}`}
            checked={mode === 'all'}
            onChange={() => setMode('all')}
          />
          All accounts
        </label>
        <label htmlFor={`broadcast-selected-${templateId}`} className="flex items-center gap-1.5 cursor-pointer">
          <input
            id={`broadcast-selected-${templateId}`}
            type="radio"
            name={`broadcast-mode-${templateId}`}
            checked={mode === 'selected'}
            onChange={() => setMode('selected')}
          />
          Selected accounts
        </label>
      </div>

      {mode === 'selected' && (
        <div className="border border-themed rounded-lg max-h-56 overflow-y-auto divide-y divide-themed">
          {loadingOrgs && <p className="px-3 py-3 text-xs text-muted-themed">Loading accounts…</p>}
          {!loadingOrgs && orgs?.length === 0 && <p className="px-3 py-3 text-xs text-muted-themed">No accounts found.</p>}
          {!loadingOrgs && orgs?.map((org) => (
            <label key={org.id} htmlFor={`broadcast-org-${templateId}-${org.id}`} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-raised-themed">
              <Checkbox
                id={`broadcast-org-${templateId}-${org.id}`}
                checked={selectedOrgIds.has(org.id)}
                onChange={() => toggleOrg(org.id)}
              />
              {org.name}
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={handleBroadcast}
          disabled={dispatching || (mode === 'selected' && selectedOrgIds.size === 0)}
          className="text-sm inline-flex items-center gap-1.5"
        >
          {dispatching ? 'Queuing…' : 'Broadcast'}
        </Button>
        {dispatched && (
          <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--accent-gold)' }}>
            <Check className="w-3.5 h-3.5" /> Queued — accounts will update shortly.
          </span>
        )}
        <Button variant="ghost" onClick={() => setOpen(false)} className="text-xs ml-auto">Close</Button>
      </div>
    </div>
  )
}
