'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'
import { createMaintenanceScheduleTemplate, broadcastMaintenanceTemplate, type BroadcastResult } from '@/app/(dashboard)/maintenance/maintenance-template-actions'
import type { VendorSpecialty } from '@/types/database'
import { CatalogPicker } from './catalog-picker'
import { TemplateItemRow } from './template-item-row'
import { ApplyTemplateDialog } from './apply-template-dialog'
import {
  EMPTY_TEMPLATE_ITEM,
  catalogItemToTemplateItem,
  type CatalogItem,
  type Property,
  type NewTemplateItem,
} from './template-builder-shared'

export type { CatalogItem, Property, NewTemplateItem }

export function CreateTemplateBuilder({
  catalogItems,
  properties,
}: Readonly<{ catalogItems: CatalogItem[]; properties: Property[] }>) {
  const [name, setName]                     = useState('')
  const [description, setDescription]       = useState('')
  const [items, setItems]                   = useState<NewTemplateItem[]>([{ ...EMPTY_TEMPLATE_ITEM }])
  const [saving, setSaving]                 = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [showCatalog, setShowCatalog]       = useState(catalogItems.length > 0)

  // Post-creation "apply to properties" step
  const [createdTemplateId, setCreatedTemplateId]     = useState<string | null>(null)
  const [createdTemplateName, setCreatedTemplateName] = useState('')
  const [applyMode, setApplyMode]                     = useState<'all' | 'select'>('all')
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([])
  const [applying, setApplying]                       = useState(false)
  const [applyError, setApplyError]                   = useState<string | null>(null)
  const [applyResult, setApplyResult]                 = useState<BroadcastResult | null>(null)

  const addItem = () => setItems((prev) => [...prev, { ...EMPTY_TEMPLATE_ITEM }])
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i))
  const updateItem = (i: number, field: keyof NewTemplateItem, value: string) =>
    setItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)))

  const isCatalogSelected = (catalogId: string) => items.some((it) => it.catalogId === catalogId)
  const allCatalogSelected = catalogItems.length > 0 && catalogItems.every((ci) => isCatalogSelected(ci.id))

  const toggleCatalogItem = (ci: CatalogItem) => {
    setItems((prev) => {
      if (prev.some((it) => it.catalogId === ci.id)) {
        const next = prev.filter((it) => it.catalogId !== ci.id)
        return next.length ? next : [{ ...EMPTY_TEMPLATE_ITEM }]
      }
      const withoutEmpty = prev.filter((it) => it.name.trim() || it.catalogId)
      return [...withoutEmpty, catalogItemToTemplateItem(ci)]
    })
  }

  const toggleAllCatalog = () => {
    if (allCatalogSelected) {
      setItems((prev) => {
        const next = prev.filter((it) => !it.catalogId)
        return next.length ? next : [{ ...EMPTY_TEMPLATE_ITEM }]
      })
    } else {
      setItems((prev) => {
        const withoutEmpty = prev.filter((it) => it.name.trim() || it.catalogId)
        const existing = new Set(withoutEmpty.filter((it) => it.catalogId).map((it) => it.catalogId))
        const toAdd = catalogItems.filter((ci) => !existing.has(ci.id)).map(catalogItemToTemplateItem)
        return [...withoutEmpty, ...toAdd]
      })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Template name is required'); return }
    const validItems = items.filter((it) => it.name.trim())
    if (!validItems.length) { setError('Add at least one item'); return }
    setSaving(true)
    setError(null)
    const result = await createMaintenanceScheduleTemplate({
      name:        name.trim(),
      description: description.trim() || null,
      items:       validItems.map((it, i) => ({
        name:                  it.name.trim(),
        description:           it.description.trim() || null,
        schedule_frequency:    it.schedule_frequency,
        vendor_specialty_hint: (it.vendor_specialty_hint as VendorSpecialty | null) || null,
        estimated_cost:        it.estimated_cost ? Number.parseFloat(it.estimated_cost) : null,
        sort_order:            i,
      })),
    })
    setSaving(false)
    if (result.error) { setError(result.error); return }
    if (result.templateId) {
      setCreatedTemplateName(name.trim())
      setCreatedTemplateId(result.templateId)
    }
  }

  const allPropertiesSelected = properties.length > 0 && selectedPropertyIds.length === properties.length

  const toggleProperty = (id: string) =>
    setSelectedPropertyIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  const toggleAllProperties = () =>
    setSelectedPropertyIds(allPropertiesSelected ? [] : properties.map((p) => p.id))

  const handleApply = async () => {
    if (!createdTemplateId) return
    const propertyIds = applyMode === 'all' ? properties.map((p) => p.id) : selectedPropertyIds
    if (propertyIds.length === 0) { setApplyError('Select at least one property'); return }
    setApplying(true)
    setApplyError(null)
    const res = await broadcastMaintenanceTemplate(createdTemplateId, propertyIds)
    setApplying(false)
    if (res.error) { setApplyError(res.error); return }
    setApplyResult(res)
  }

  const resetAfterCreate = () => {
    setCreatedTemplateId(null)
    setCreatedTemplateName('')
    setApplyMode('all')
    setSelectedPropertyIds([])
    setApplyError(null)
    setApplyResult(null)
    setName('')
    setDescription('')
    setItems([{ ...EMPTY_TEMPLATE_ITEM }])
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        <div>
          <label htmlFor="new-mtx-template-name" className="label">Template Name <RequiredMark /></label>
          <Input id="new-mtx-template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. STR Annual Maintenance" required />
        </div>
        <div>
          <label htmlFor="new-mtx-template-description" className="label">Description</label>
          <Input id="new-mtx-template-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description…" />
        </div>

        {catalogItems.length > 0 && (
          <CatalogPicker
            catalogItems={catalogItems}
            show={showCatalog}
            onToggleShow={() => setShowCatalog((s) => !s)}
            isSelected={isCatalogSelected}
            allSelected={allCatalogSelected}
            onToggleItem={toggleCatalogItem}
            onToggleAll={toggleAllCatalog}
          />
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="create-template-builder-items" className="label mb-0">Items <RequiredMark /></label>
            <Button variant="secondary" type="button" onClick={addItem} className="text-xs py-1 px-2 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add Item
            </Button>
          </div>
          <div className="space-y-2">
            {items.map((item, i) => (
              <TemplateItemRow
                key={i}
                index={i}
                item={item}
                canRemove={items.length > 1}
                onUpdate={updateItem}
                onRemove={removeItem}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-themed">
          <Button type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create Template'}
          </Button>
        </div>
      </form>

      <ApplyTemplateDialog
        open={createdTemplateId !== null}
        templateName={createdTemplateName}
        properties={properties}
        applyMode={applyMode}
        onApplyModeChange={setApplyMode}
        selectedPropertyIds={selectedPropertyIds}
        onToggleProperty={toggleProperty}
        allPropertiesSelected={allPropertiesSelected}
        onToggleAllProperties={toggleAllProperties}
        applying={applying}
        applyError={applyError}
        applyResult={applyResult}
        onApply={handleApply}
        onClose={resetAfterCreate}
      />
    </>
  )
}
