'use client'

import { useState, useTransition } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { createInventoryTemplate } from '../actions'
import { applyTemplateToProperties } from '@/app/(dashboard)/inventory/actions'
import type { InventoryCategory } from '@/types/database'

interface CatalogItem {
  id:           string
  name:         string
  category:     InventoryCategory
  default_unit: string
}

interface Property { id: string; name: string }

function groupByCategory(items: CatalogItem[]): Array<[InventoryCategory, CatalogItem[]]> {
  const groups = new Map<InventoryCategory, CatalogItem[]>()
  for (const item of items) {
    const bucket = groups.get(item.category) ?? []
    bucket.push(item)
    groups.set(item.category, bucket)
  }
  return Array.from(groups.entries())
}

export function CreateTemplateBuilder({
  catalogItems,
  properties,
}: Readonly<{ catalogItems: CatalogItem[]; properties: Property[] }>) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showNameDialog, setShowNameDialog] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [creating, startCreate] = useTransition()
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdTemplateId, setCreatedTemplateId] = useState<string | null>(null)
  const [createdTemplateName, setCreatedTemplateName] = useState('')

  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([])
  const [applying, startApply] = useTransition()
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ applied: number } | null>(null)

  const groups = groupByCategory(catalogItems)

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleCategory = (categoryItems: CatalogItem[]) => {
    const allSelected = categoryItems.every((item) => selected.has(item.id))
    setSelected((prev) => {
      const next = new Set(prev)
      categoryItems.forEach((item) => {
        if (allSelected) next.delete(item.id)
        else next.add(item.id)
      })
      return next
    })
  }

  const closeDialog = () => {
    setShowNameDialog(false)
    setTemplateName('')
    setCreateError(null)
    setCreatedTemplateId(null)
    setSelectedPropertyIds([])
    setApplyError(null)
    setApplyResult(null)
  }

  const handleCreate = () => {
    if (!templateName.trim()) { setCreateError('Template name is required.'); return }
    startCreate(async () => {
      setCreateError(null)
      const result = await createInventoryTemplate(templateName.trim(), Array.from(selected))
      if (result.error || !result.templateId) {
        setCreateError(result.error ?? 'Failed to create template.')
        return
      }
      setCreatedTemplateId(result.templateId)
      setCreatedTemplateName(templateName.trim())
      setSelected(new Set())
    })
  }

  const toggleProperty = (id: string) =>
    setSelectedPropertyIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  const handleApply = () => {
    if (!createdTemplateId || selectedPropertyIds.length === 0) return
    startApply(async () => {
      setApplyError(null)
      const result = await applyTemplateToProperties(createdTemplateId, selectedPropertyIds)
      if (result.error) { setApplyError(result.error); return }
      setApplyResult({ applied: result.applied })
    })
  }

  return (
    <div className="space-y-4">
      {groups.length === 0 && (
        <p className="text-sm text-muted-themed">
          No items in your Master List yet — add some on the Master List tab first.
        </p>
      )}

      {groups.map(([category, categoryItems]) => {
        const allSelected = categoryItems.every((item) => selected.has(item.id))
        return (
          <div key={category} className="border border-themed rounded-xl overflow-hidden">
            <label className="flex items-center gap-2 px-4 py-2.5 cursor-pointer" style={{ background: 'var(--bg-raised)' }}>
              <Checkbox checked={allSelected} onChange={() => toggleCategory(categoryItems)} />
              <span className="text-sm font-semibold text-primary-themed">{INVENTORY_CATEGORY_LABELS[category]}</span>
            </label>
            <div className="divide-y divide-themed">
              {categoryItems.map((item) => (
                <label key={item.id} className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-raised-themed transition-colors">
                  <Checkbox checked={selected.has(item.id)} onChange={() => toggleItem(item.id)} />
                  <span className="text-sm text-primary-themed">{item.name}</span>
                  <span className="text-xs text-muted-themed ml-auto">{item.default_unit}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}

      {groups.length > 0 && (
        <div className="flex justify-end pt-2">
          <Button onClick={() => setShowNameDialog(true)} disabled={selected.size === 0}>
            Save Template ({selected.size} item{selected.size !== 1 ? 's' : ''})
          </Button>
        </div>
      )}

      <Dialog
        open={showNameDialog}
        onClose={closeDialog}
        title={createdTemplateId ? 'Apply Template' : 'Name This Template'}
        maxWidthClassName="max-w-sm"
      >
        {!createdTemplateId ? (
          <div className="space-y-4">
            {createError && <InlineAlert tone="error">{createError}</InlineAlert>}
            <div>
              <label htmlFor="new-template-name" className="label">Template name</label>
              <Input
                id="new-template-name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. Beachfront Standard"
              />
            </div>
            <Button onClick={handleCreate} disabled={creating || !templateName.trim()} className="w-full">
              {creating ? 'Creating…' : 'Create Template'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-themed -mt-2">&quot;{createdTemplateName}&quot; was created</p>

            {applyError && <InlineAlert tone="error">{applyError}</InlineAlert>}

            {applyResult ? (
              <>
                <InlineAlert tone="success" className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Applied — {applyResult.applied} item{applyResult.applied !== 1 ? 's' : ''} added across selected properties.</span>
                </InlineAlert>
                <Button onClick={closeDialog} className="w-full">Done</Button>
              </>
            ) : properties.length === 0 ? (
              <>
                <p className="text-sm text-muted-themed">
                  No properties to apply this template to yet. You can apply it later from Saved Templates.
                </p>
                <Button onClick={closeDialog} className="w-full">Done</Button>
              </>
            ) : (
              <>
                <p className="text-sm text-secondary-themed">Apply this template to any properties now?</p>
                <div className="max-h-48 overflow-y-auto border border-themed rounded-lg divide-y divide-themed">
                  {properties.map((property) => (
                    <label key={property.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-raised-themed transition-colors">
                      <Checkbox
                        checked={selectedPropertyIds.includes(property.id)}
                        onChange={() => toggleProperty(property.id)}
                      />
                      <span className="text-sm text-primary-themed">{property.name}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleApply} disabled={applying || selectedPropertyIds.length === 0} className="flex-1">
                    {applying ? 'Applying…' : `Apply to ${selectedPropertyIds.length || ''} propert${selectedPropertyIds.length === 1 ? 'y' : 'ies'}`}
                  </Button>
                  <Button variant="ghost" onClick={closeDialog}>Skip</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
