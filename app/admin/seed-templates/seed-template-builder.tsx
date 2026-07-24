'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Camera, Check, Home } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  createSeedTemplate,
  renameSeedTemplate,
  deleteSeedTemplate,
  saveSeedTemplateItems,
  setSeedTemplateAutoInclude,
  type SeedTemplateItemInput,
} from './actions'

interface ItemState {
  tempId: string
  task: string
  requires_photo: boolean
  notes: string
}

interface TemplateState {
  id: string
  name: string
  autoInclude: boolean
  items: ItemState[]
}

function makeId() {
  if (typeof globalThis.window === 'undefined') return 'ssr'
  return crypto.randomUUID()
}

function toItemState(item: { task: string; requires_photo: boolean; notes: string }): ItemState {
  return { tempId: makeId(), task: item.task, requires_photo: item.requires_photo, notes: item.notes }
}

// Pure list-transform helpers kept at module scope — mirrors
// components/templates/room-library-builder.tsx's own reasoning for
// keeping cognitive complexity down by not nesting these inside handlers.
function renameTemplateInList(templates: TemplateState[], id: string, name: string): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, name } : t))
}

function setAutoIncludeInList(templates: TemplateState[], id: string, autoInclude: boolean): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, autoInclude } : t))
}

function addItemToTemplate(templates: TemplateState[], id: string): TemplateState[] {
  return templates.map((t) =>
    t.id === id
      ? { ...t, items: [...t.items, { tempId: makeId(), task: '', requires_photo: false, notes: '' }] }
      : t
  )
}

function filterOutItem(items: ItemState[], itemTempId: string): ItemState[] {
  return items.filter((i) => i.tempId !== itemTempId)
}

function removeItemFromTemplate(templates: TemplateState[], id: string, itemTempId: string): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, items: filterOutItem(t.items, itemTempId) } : t))
}

function mapUpdatedItem(items: ItemState[], itemTempId: string, field: keyof ItemState, value: unknown): ItemState[] {
  return items.map((i) => (i.tempId === itemTempId ? { ...i, [field]: value } : i))
}

function updateItemInTemplate(
  templates: TemplateState[],
  id: string,
  itemTempId: string,
  field: keyof ItemState,
  value: unknown
): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, items: mapUpdatedItem(t.items, itemTempId, field, value) } : t))
}

function reorderItems(items: ItemState[], itemTempId: string, dir: -1 | 1): ItemState[] {
  const idx = items.findIndex((i) => i.tempId === itemTempId)
  const swap = idx + dir
  if (swap < 0 || swap >= items.length) {
    return items
  }
  const next = [...items]
  ;[next[idx], next[swap]] = [next[swap], next[idx]]
  return next
}

function moveItemInTemplate(templates: TemplateState[], id: string, itemTempId: string, dir: -1 | 1): TemplateState[] {
  return templates.map((t) => (t.id === id ? { ...t, items: reorderItems(t.items, itemTempId, dir) } : t))
}

function removeTemplateFromList(templates: TemplateState[], id: string): TemplateState[] {
  return templates.filter((t) => t.id !== id)
}

function buildItemsPayload(items: ItemState[]): SeedTemplateItemInput[] {
  return items.map((item, i) => ({
    task:           item.task,
    requires_photo: item.requires_photo,
    notes:          item.notes,
    sort_order:     i,
  }))
}

function saveButtonLabel(saving: boolean, saved: boolean) {
  if (saving) return 'Saving…'
  if (saved) return <><Check className="w-4 h-4" /> Saved</>
  return 'Save Template'
}

export function SeedTemplateBuilder({
  initialTemplates,
}: Readonly<{
  initialTemplates: Array<{ id: string; name: string; autoInclude: boolean; items: Array<{ id: string; task: string; requires_photo: boolean; notes: string }> }>
}>) {
  const [templates, setTemplates] = useState<TemplateState[]>(() =>
    initialTemplates.map((t) => ({ id: t.id, name: t.name, autoInclude: t.autoInclude, items: t.items.map(toItemState) }))
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newTemplateName, setNewTemplateName] = useState('')
  const [creating, startCreate] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null)

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
      const result = await createSeedTemplate(name)
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to create template.')
        return
      }
      setTemplates((prev) => [...prev, { id: result.id!, name, autoInclude: false, items: [] }])
      setExpanded((prev) => new Set(prev).add(result.id!))
      setNewTemplateName('')
      setError(null)
    })
  }

  const updateTemplateName = (id: string, name: string) => {
    setTemplates((prev) => renameTemplateInList(prev, id, name))
  }

  const toggleAutoInclude = (id: string) => {
    const template = templates.find((t) => t.id === id)
    if (!template) return
    const next = !template.autoInclude
    setTemplates((prev) => setAutoIncludeInList(prev, id, next))
    startCreate(async () => {
      const result = await setSeedTemplateAutoInclude(id, next)
      if (result.error) {
        setError(result.error)
        setTemplates((prev) => setAutoIncludeInList(prev, id, !next))
      }
    })
  }

  const addItem = (id: string) => {
    setTemplates((prev) => addItemToTemplate(prev, id))
  }

  const removeItem = (id: string, itemTempId: string) => {
    setTemplates((prev) => removeItemFromTemplate(prev, id, itemTempId))
  }

  const updateItem = (id: string, itemTempId: string, field: keyof ItemState, value: unknown) => {
    setTemplates((prev) => updateItemInTemplate(prev, id, itemTempId, field, value))
  }

  const moveItem = (id: string, itemTempId: string, dir: -1 | 1) => {
    setTemplates((prev) => moveItemInTemplate(prev, id, itemTempId, dir))
  }

  const handleSaveTemplate = (template: TemplateState, nameChanged: boolean) => {
    startCreate(async () => {
      setError(null)
      if (nameChanged) {
        const renameResult = await renameSeedTemplate(template.id, template.name)
        if (renameResult.error) { setError(renameResult.error); return }
      }
      const itemsResult = await saveSeedTemplateItems(template.id, buildItemsPayload(template.items))
      if (itemsResult.error) { setError(itemsResult.error); return }
      setSavedTemplateId(template.id)
      setTimeout(() => setSavedTemplateId(null), 2000)
    })
  }

  const handleDeleteTemplate = (id: string) => {
    startCreate(async () => {
      setError(null)
      const result = await deleteSeedTemplate(id)
      if (result.error) { setError(result.error); return }
      setTemplates((prev) => removeTemplateFromList(prev, id))
    })
  }

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {templates.length === 0 && (
        <div className="border border-dashed border-themed rounded-xl p-8 text-center">
          <Home className="w-6 h-6 mx-auto mb-2 text-muted-themed" />
          <p className="text-sm text-muted-themed">
            No default templates yet. Add the ones every new org should start
            with — e.g. &quot;Kitchen&quot; or &quot;Whole Home&quot;.
          </p>
        </div>
      )}

      {templates.map((template) => {
        const isOpen = expanded.has(template.id)
        return (
          <TemplateCard
            key={template.id}
            template={template}
            isOpen={isOpen}
            saved={savedTemplateId === template.id}
            onToggle={() => toggleExpanded(template.id)}
            onNameChange={(name) => updateTemplateName(template.id, name)}
            onToggleAutoInclude={() => toggleAutoInclude(template.id)}
            onAddItem={() => addItem(template.id)}
            onRemoveItem={(itemTempId) => removeItem(template.id, itemTempId)}
            onUpdateItem={(itemTempId, field, value) => updateItem(template.id, itemTempId, field, value)}
            onMoveItem={(itemTempId, dir) => moveItem(template.id, itemTempId, dir)}
            onSave={(nameChanged) => handleSaveTemplate(template, nameChanged)}
            onDelete={() => handleDeleteTemplate(template.id)}
            saving={creating}
          />
        )
      })}

      <div className="flex gap-2">
        <input
          value={newTemplateName}
          onChange={(e) => setNewTemplateName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTemplate() }}
          placeholder="New template name — e.g. Garage"
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
  onToggle,
  onNameChange,
  onToggleAutoInclude,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  onMoveItem,
  onSave,
  onDelete,
}: Readonly<{
  template: TemplateState
  isOpen: boolean
  saved: boolean
  saving: boolean
  onToggle: () => void
  onNameChange: (name: string) => void
  onToggleAutoInclude: () => void
  onAddItem: () => void
  onRemoveItem: (itemTempId: string) => void
  onUpdateItem: (itemTempId: string, field: keyof ItemState, value: unknown) => void
  onMoveItem: (itemTempId: string, dir: -1 | 1) => void
  onSave: (nameChanged: boolean) => void
  onDelete: () => void
}>) {
  const [initialName] = useState(template.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="border border-themed rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
      >
        <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform text-muted-themed ${isOpen ? 'rotate-90' : ''}`} />
        <span className="text-sm font-semibold text-primary-themed flex-1">{template.name}</span>
        {template.autoInclude && (
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0"
            style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
          >
            Auto-included
          </span>
        )}
        <span className="text-xs text-muted-themed">{template.items.length} task{template.items.length !== 1 ? 's' : ''}</span>
      </button>

      {isOpen && (
        <div className="border-t border-themed px-4 py-4 space-y-3">
          <input
            value={template.name}
            onChange={(e) => onNameChange(e.target.value)}
            className="input w-full text-sm font-medium"
            placeholder="Template name"
          />

          <label htmlFor={`admin-auto-include-${template.id}`} className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id={`admin-auto-include-${template.id}`}
              checked={template.autoInclude}
              onChange={onToggleAutoInclude}
              className="mt-0.5"
            />
            <span className="text-xs text-muted-themed">
              Automatically include this on every newly-seeded org&apos;s
              checklist (Kitchen, Living Room, and Whole Home today — not
              opt-in per-quantity rooms like Bedroom or Bathroom).
            </span>
          </label>

          <div className="divide-y divide-themed border border-themed rounded-lg overflow-hidden">
            {template.items.map((item, ii) => (
              <div key={item.tempId} className="flex items-center gap-2 px-3 py-2 group hover:bg-raised-themed">
                <div className="flex gap-0.5">
                  <Button variant="ghost" onClick={() => onMoveItem(item.tempId, -1)} disabled={ii === 0} className="p-0.5 disabled:opacity-30">
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" onClick={() => onMoveItem(item.tempId, 1)} disabled={ii === template.items.length - 1} className="p-0.5 disabled:opacity-30">
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </div>
                <input
                  value={item.task}
                  onChange={(e) => onUpdateItem(item.tempId, 'task', e.target.value)}
                  placeholder="Task description…"
                  className="flex-1 text-sm text-primary-themed bg-transparent focus:outline-none placeholder:text-[var(--text-muted)] border-b border-[color:var(--border)] focus:border-[var(--accent-gold)] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => onUpdateItem(item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={item.requires_photo ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                  style={item.requires_photo ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => onRemoveItem(item.tempId)} className="text-muted-themed hover:text-red-500 transition-colors p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onAddItem}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm text-muted-themed hover:text-[var(--accent-gold)] hover:bg-[var(--accent-gold-dim)] rounded-lg transition-colors border border-dashed border-themed"
          >
            <Plus className="w-3.5 h-3.5" /> Add task
          </button>

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <Button
              variant="secondary"
              onClick={() => onSave(template.name !== initialName)}
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
                className="text-sm ml-auto text-muted-themed hover:text-red-500"
              >
                Delete Template
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
