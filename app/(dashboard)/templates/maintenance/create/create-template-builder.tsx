'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Plus, Trash2, AlertTriangle, CheckCircle2, Clock, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'
import { createMaintenanceScheduleTemplate, broadcastMaintenanceTemplate, type BroadcastResult } from '@/app/(dashboard)/maintenance/actions'
import type { ScheduleFrequency, VendorSpecialty } from '@/types/database'

const SPECIALTY_LABELS: Record<string, string> = {
  plumbing: 'Plumbing', electrical: 'Electrical', hvac: 'HVAC',
  landscaping: 'Landscaping', cleaning: 'Cleaning', pest_control: 'Pest Control',
  pool: 'Pool', roofing: 'Roofing', general: 'General', other: 'Other',
}

const FREQUENCY_LABELS: Partial<Record<ScheduleFrequency, string>> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  semi_annual: 'Semi-annual',
  annual:      'Annual',
}

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'weekly',      label: 'Weekly'      },
  { value: 'biweekly',    label: 'Bi-weekly'   },
  { value: 'monthly',     label: 'Monthly'     },
  { value: 'quarterly',   label: 'Quarterly'   },
  { value: 'semi_annual', label: 'Semi-annual' },
  { value: 'annual',      label: 'Annual'      },
]

interface CatalogItem {
  id:                    string
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
  is_optional_flag:      string | null
  sort_order:            number
}

interface Property { id: string; name: string }

interface NewTemplateItem {
  name:                  string
  description:           string
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | ''
  estimated_cost:        string
  catalogId?:            string
}

const EMPTY_TEMPLATE_ITEM: NewTemplateItem = {
  name: '', description: '', schedule_frequency: 'quarterly', vendor_specialty_hint: '', estimated_cost: '',
}

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

  const catalogItemToTemplateItem = (ci: CatalogItem): NewTemplateItem => ({
    name:                  ci.name,
    description:           ci.description ?? '',
    schedule_frequency:    ci.schedule_frequency,
    vendor_specialty_hint: (ci.vendor_specialty_hint ?? '') as VendorSpecialty | '',
    estimated_cost:        ci.estimated_cost != null ? String(ci.estimated_cost) : '',
    catalogId:             ci.id,
  })

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

  const catalogGroups = useMemo(() => {
    const groups: Record<string, CatalogItem[]> = {}
    for (const ci of catalogItems) {
      const key = ci.vendor_specialty_hint ?? 'general'
      if (!groups[key]) groups[key] = []
      groups[key].push(ci)
    }
    return groups
  }, [catalogItems])

  const catalogGroupKeys = useMemo(() => Object.keys(catalogGroups).sort((a, b) => {
    if (a === 'general') return 1
    if (b === 'general') return -1
    return (SPECIALTY_LABELS[a] ?? a).localeCompare(SPECIALTY_LABELS[b] ?? b)
  }), [catalogGroups])

  const allCatalogSelected = catalogItems.length > 0 && catalogItems.every((ci) => isCatalogSelected(ci.id))

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
        estimated_cost:        it.estimated_cost ? parseFloat(it.estimated_cost) : null,
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
          <div className="border border-themed rounded-xl bg-canvas-themed">
            <button
              type="button"
              onClick={() => setShowCatalog((s) => !s)}
              className="flex items-center justify-between w-full text-left p-3"
            >
              <span className="text-sm font-medium text-secondary-themed">
                Add from FieldStay Standard <span className="text-muted-themed font-normal">({catalogItems.length} items)</span>
              </span>
              <ChevronDown className={cn('w-4 h-4 text-muted-themed transition-transform flex-shrink-0', showCatalog && 'rotate-180')} />
            </button>
            {showCatalog && (
              <div className="px-3 pb-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-themed">Select items to include in this template</p>
                  <button type="button" onClick={toggleAllCatalog} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                    {allCatalogSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
                  {catalogGroupKeys.map((key) => (
                    <div key={key}>
                      <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">
                        {SPECIALTY_LABELS[key] ?? key}
                      </p>
                      <div className="space-y-1">
                        {catalogGroups[key].map((ci) => (
                          <label key={ci.id} className="flex items-center gap-2.5 text-sm bg-card-themed rounded-lg px-3 py-1.5 cursor-pointer border border-themed">
                            <Checkbox
                              checked={isCatalogSelected(ci.id)}
                              onChange={() => toggleCatalogItem(ci)}
                              className="flex-shrink-0"
                            />
                            <span className="text-secondary-themed flex-1 truncate">{ci.name}</span>
                            {ci.is_optional_flag && (
                              <Badge tone="amber" className="text-xs flex-shrink-0 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                {ci.is_optional_flag}
                              </Badge>
                            )}
                            <Badge tone="slate" className="text-xs flex-shrink-0">
                              {FREQUENCY_LABELS[ci.schedule_frequency] ?? ci.schedule_frequency}
                            </Badge>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">Items <RequiredMark /></label>
            <Button variant="secondary" type="button" onClick={addItem} className="text-xs py-1 px-2 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add Item
            </Button>
          </div>
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={i} className="border border-themed rounded-xl p-3 space-y-2 bg-canvas-themed">
                <div className="flex items-start gap-2">
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`mtx-item-name-${i}`} className="label text-xs">Item Name <RequiredMark /></label>
                      <Input id={`mtx-item-name-${i}`} value={item.name} onChange={(e) => updateItem(i, 'name', e.target.value)}
                             className="text-sm" placeholder="e.g. HVAC Filter Replacement" />
                    </div>
                    <div>
                      <label htmlFor={`mtx-item-frequency-${i}`} className="label text-xs">Frequency</label>
                      <select id={`mtx-item-frequency-${i}`} value={item.schedule_frequency}
                              onChange={(e) => updateItem(i, 'schedule_frequency', e.target.value)}
                              className="input text-sm">
                        {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`mtx-item-specialty-${i}`} className="label text-xs">Vendor Specialty</label>
                      <select id={`mtx-item-specialty-${i}`} value={item.vendor_specialty_hint}
                              onChange={(e) => updateItem(i, 'vendor_specialty_hint', e.target.value)}
                              className="input text-sm">
                        <option value="">None</option>
                        {Object.entries(SPECIALTY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`mtx-item-cost-${i}`} className="label text-xs">Est. Cost ($)</label>
                      <Input id={`mtx-item-cost-${i}`} type="number" min="0" step="0.01" value={item.estimated_cost}
                             onChange={(e) => updateItem(i, 'estimated_cost', e.target.value)}
                             className="text-sm" placeholder="0.00" />
                    </div>
                  </div>
                  {items.length > 1 && (
                    <Button variant="ghost" type="button" onClick={() => removeItem(i)}
                            className="p-1.5 text-[var(--accent-red)] hover:opacity-80 mt-5 flex-shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-themed">
          <Button type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create Template'}
          </Button>
        </div>
      </form>

      <Dialog open={createdTemplateId !== null} onClose={resetAfterCreate} title="Apply Template" maxWidthClassName="max-w-md">
        <p className="text-xs text-muted-themed -mt-3 mb-4">&quot;{createdTemplateName}&quot; was created</p>

        {applyError && <InlineAlert tone="error" className="mb-4">{applyError}</InlineAlert>}

        {applyResult ? (
          <div className="space-y-4">
            <InlineAlert tone="success" className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Template applied</p>
                <p className="mt-1">
                  Created {applyResult.created} schedule{applyResult.created !== 1 ? 's' : ''}
                  {(applyResult.skipped ?? 0) > 0 && <> · {applyResult.skipped} skipped (already existed)</>}
                </p>
              </div>
            </InlineAlert>
            <Button onClick={resetAfterCreate} className="w-full">Done</Button>
          </div>
        ) : properties.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-themed">No properties found to apply this template to. You can broadcast it later from Saved Templates.</p>
            <Button onClick={resetAfterCreate} className="w-full">Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-secondary-themed">Apply this template&apos;s schedules now?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setApplyMode('all')}
                className={cn(
                  'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
                  applyMode === 'all' ? 'font-medium' : 'border-themed text-secondary-themed'
                )}
                style={applyMode === 'all' ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
              >
                All properties ({properties.length})
              </button>
              <button
                type="button"
                onClick={() => setApplyMode('select')}
                className={cn(
                  'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
                  applyMode === 'select' ? 'font-medium' : 'border-themed text-secondary-themed'
                )}
                style={applyMode === 'select' ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
              >
                Select properties
              </button>
            </div>

            {applyMode === 'select' && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-secondary-themed">Properties</p>
                  <button type="button" onClick={toggleAllProperties} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                    {allPropertiesSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {properties.map((p) => (
                    <label key={p.id} className="flex items-center gap-2.5 text-sm bg-canvas-themed rounded-lg px-3 py-2 cursor-pointer">
                      <Checkbox
                        checked={selectedPropertyIds.includes(p.id)}
                        onChange={() => toggleProperty(p.id)}
                      />
                      <span className="text-secondary-themed">{p.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-4 mt-2 border-t border-themed">
              <Button variant="ghost" type="button" onClick={resetAfterCreate}>Skip</Button>
              <Button
                onClick={handleApply}
                disabled={applying || (applyMode === 'select' && selectedPropertyIds.length === 0)}
                className="flex-1 flex items-center justify-center gap-2"
              >
                {applying ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {applying ? 'Applying…' : 'Apply Template'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}
