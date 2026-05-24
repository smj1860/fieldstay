'use client'

import { useState, useTransition } from 'react'
import { saveChecklistTemplate, completeChecklistStep } from './actions'
import { Plus, Trash2, ChevronUp, ChevronDown, Camera } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Item { tempId: string; id?: string; task: string; requires_photo: boolean; notes: string }
interface Section { tempId: string; id?: string; name: string; items: Item[] }

function makeId() { return Math.random().toString(36).slice(2) }

const DEFAULT_SECTIONS: Section[] = [
  {
    tempId: makeId(), name: 'Kitchen', items: [
      { tempId: makeId(), task: 'Wipe all countertops and surfaces', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Clean stovetop and oven exterior', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Empty and wipe down refrigerator', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Run and empty dishwasher', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Restock dish soap and sponge', requires_photo: false, notes: '' },
    ],
  },
  {
    tempId: makeId(), name: 'Bathrooms', items: [
      { tempId: makeId(), task: 'Scrub toilet, sink, and tub/shower', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Replace toiletries (shampoo, soap, etc.)', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Restock toilet paper', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Clean mirrors', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Replace towels with fresh set', requires_photo: true, notes: '' },
    ],
  },
  {
    tempId: makeId(), name: 'Bedrooms', items: [
      { tempId: makeId(), task: 'Strip and remake all beds', requires_photo: true, notes: '' },
      { tempId: makeId(), task: 'Vacuum floors and under beds', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Dust furniture and ceiling fans', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Check closets and nightstands for guest items', requires_photo: false, notes: '' },
    ],
  },
  {
    tempId: makeId(), name: 'Living / Common Areas', items: [
      { tempId: makeId(), task: 'Vacuum all rugs and sweep hard floors', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Wipe down all surfaces and remotes', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Empty all trash cans and replace liners', requires_photo: false, notes: '' },
    ],
  },
  {
    tempId: makeId(), name: 'Final Walkthrough', items: [
      { tempId: makeId(), task: 'Check all windows and doors locked', requires_photo: false, notes: '' },
      { tempId: makeId(), task: 'Take photo of front entrance', requires_photo: true, notes: '' },
      { tempId: makeId(), task: 'Confirm A/C set to departure temp', requires_photo: false, notes: '' },
    ],
  },
]

function buildInitialSections(template: { checklist_template_sections?: Array<{ id: string; name: string; sort_order: number; checklist_template_items?: Array<{ id: string; task: string; requires_photo: boolean; notes: string | null; sort_order: number }> }> } | null): Section[] {
  if (!template?.checklist_template_sections?.length) return DEFAULT_SECTIONS

  return [...template.checklist_template_sections]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({
      tempId: makeId(),
      id: s.id,
      name: s.name,
      items: [...(s.checklist_template_items ?? [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((item) => ({
          tempId: makeId(),
          id: item.id,
          task: item.task,
          requires_photo: item.requires_photo,
          notes: item.notes ?? '',
        })),
    }))
}

export function ChecklistBuilder({
  propertyId,
  template,
}: {
  propertyId: string
  template: { id: string; name: string; checklist_template_sections?: Array<{ id: string; name: string; sort_order: number; checklist_template_items?: Array<{ id: string; task: string; requires_photo: boolean; notes: string | null; sort_order: number }> }> } | null
}) {
  const [sections, setSections] = useState<Section[]>(() => buildInitialSections(template))
  const [saving, startSave] = useTransition()
  const [completing, startComplete] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addSection = () => {
    setSections((p) => [...p, { tempId: makeId(), name: 'New Section', items: [] }])
  }

  const removeSection = (tempId: string) => {
    setSections((p) => p.filter((s) => s.tempId !== tempId))
  }

  const updateSection = (tempId: string, name: string) => {
    setSections((p) => p.map((s) => s.tempId === tempId ? { ...s, name } : s))
  }

  const moveSection = (tempId: string, dir: -1 | 1) => {
    setSections((p) => {
      const idx  = p.findIndex((s) => s.tempId === tempId)
      const next = [...p]
      const swap = idx + dir
      if (swap < 0 || swap >= next.length) return p;
      [next[idx], next[swap]] = [next[swap], next[idx]]
      return next
    })
  }

  const addItem = (sectionTempId: string) => {
    setSections((p) => p.map((s) => s.tempId === sectionTempId
      ? { ...s, items: [...s.items, { tempId: makeId(), task: '', requires_photo: false, notes: '' }] }
      : s
    ))
  }

  const removeItem = (sectionTempId: string, itemTempId: string) => {
    setSections((p) => p.map((s) => s.tempId === sectionTempId
      ? { ...s, items: s.items.filter((i) => i.tempId !== itemTempId) }
      : s
    ))
  }

  const updateItem = (sectionTempId: string, itemTempId: string, field: keyof Item, value: unknown) => {
    setSections((p) => p.map((s) => s.tempId === sectionTempId
      ? { ...s, items: s.items.map((i) => i.tempId === itemTempId ? { ...i, [field]: value } : i) }
      : s
    ))
  }

  const moveItem = (sectionTempId: string, itemTempId: string, dir: -1 | 1) => {
    setSections((p) => p.map((s) => {
      if (s.tempId !== sectionTempId) return s
      const idx  = s.items.findIndex((i) => i.tempId === itemTempId)
      const next = [...s.items]
      const swap = idx + dir
      if (swap < 0 || swap >= next.length) return s;
      [next[idx], next[swap]] = [next[swap], next[idx]]
      return { ...s, items: next }
    }))
  }

  const save = () => {
    startSave(async () => {
      const payload = sections.map((s, si) => ({
        id:   s.id,
        name: s.name,
        sort_order: si,
        items: s.items.map((item, ii) => ({
          id:             item.id,
          task:           item.task,
          requires_photo: item.requires_photo,
          notes:          item.notes,
          sort_order:     ii,
        })),
      }))
      const result = await saveChecklistTemplate(propertyId, template?.id ?? null, payload)
      if (result.error) { setError(result.error); return }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {sections.map((section, si) => (
        <div key={section.tempId} className="border border-accent-200 rounded-xl overflow-hidden">
          {/* Section header */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-accent-50 border-b border-accent-200">
            <input
              value={section.name}
              onChange={(e) => updateSection(section.tempId, e.target.value)}
              className="flex-1 text-sm font-semibold bg-transparent text-accent-800 focus:outline-none border-b border-transparent focus:border-brand-500"
            />
            <div className="flex items-center gap-0.5 ml-auto">
              <button onClick={() => moveSection(section.tempId, -1)} disabled={si === 0} className="btn-ghost p-1 disabled:opacity-30">
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => moveSection(section.tempId, 1)} disabled={si === sections.length - 1} className="btn-ghost p-1 disabled:opacity-30">
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => removeSection(section.tempId)} className="btn-ghost p-1 text-accent-400 hover:text-red-500">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Items */}
          <div className="divide-y divide-accent-100">
            {section.items.map((item, ii) => (
              <div key={item.tempId} className="flex items-center gap-2 px-4 py-2.5 group hover:bg-accent-50">
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => moveItem(section.tempId, item.tempId, -1)} disabled={ii === 0} className="btn-ghost p-0.5 disabled:opacity-30">
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button onClick={() => moveItem(section.tempId, item.tempId, 1)} disabled={ii === section.items.length - 1} className="btn-ghost p-0.5 disabled:opacity-30">
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>
                <input
                  value={item.task}
                  onChange={(e) => updateItem(section.tempId, item.tempId, 'task', e.target.value)}
                  placeholder="Task description…"
                  className="flex-1 text-sm text-accent-800 bg-transparent focus:outline-none placeholder:text-accent-300"
                />
                <button
                  onClick={() => updateItem(section.tempId, item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={cn('p-1 rounded transition-colors', item.requires_photo ? 'text-brand-700 bg-brand-50' : 'text-accent-300 hover:text-accent-500')}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button onClick={() => removeItem(section.tempId, item.tempId)} className="text-accent-300 hover:text-red-500 transition-colors p-1 opacity-0 group-hover:opacity-100">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Add item */}
          <button
            onClick={() => addItem(section.tempId)}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-accent-400 hover:text-brand-700 hover:bg-brand-50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add task
          </button>
        </div>
      ))}

      <button onClick={addSection} className="btn-secondary w-full justify-center border-dashed">
        <Plus className="w-4 h-4" /> Add Section
      </button>

      <div className="flex items-center gap-3 pt-4 border-t border-accent-100">
        <button onClick={save} disabled={saving} className="btn-secondary">
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Checklist'}
        </button>
        <button
          disabled={completing}
          onClick={() => startComplete(() => completeChecklistStep(propertyId))}
          className="btn-primary"
        >
          {completing ? 'Saving…' : 'Save & Continue →'}
        </button>
      </div>
    </div>
  )
}
