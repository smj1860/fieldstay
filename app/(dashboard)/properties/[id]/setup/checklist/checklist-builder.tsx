'use client'

import { useState, useTransition } from 'react'
import { saveChecklistTemplate, completeChecklistStep, broadcastChecklistTemplate, cloneChecklistFromProperty } from './actions'
import { Plus, Trash2, ChevronUp, ChevronDown, Camera, X, Check } from 'lucide-react'

interface Item { tempId: string; id?: string; task: string; requires_photo: boolean; notes: string }
interface Section { tempId: string; id?: string; name: string; items: Item[] }

function makeId() {
  if (typeof window === 'undefined') return 'ssr'
  return Math.random().toString(36).slice(2)
}

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

interface OtherProperty { id: string; name: string }
interface SourceProperty { id: string; name: string; sectionCount: number }

export function ChecklistBuilder({
  propertyId,
  template,
  otherProperties = [],
  sourceProperties = [],
}: {
  propertyId: string
  template: { id: string; name: string; checklist_template_sections?: Array<{ id: string; name: string; sort_order: number; checklist_template_items?: Array<{ id: string; task: string; requires_photo: boolean; notes: string | null; sort_order: number }> }> } | null
  otherProperties?: OtherProperty[]
  sourceProperties?: SourceProperty[]
}) {
  const [sections, setSections] = useState<Section[]>(() => buildInitialSections(template))
  const [saving, startSave] = useTransition()
  const [completing, startComplete] = useTransition()
  const [broadcasting, startBroadcast] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [broadcastModal, setBroadcastModal] = useState(false)
  const [broadcastTargets, setBroadcastTargets] = useState<Set<string>>(new Set())
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null)
  const [cloneFromModal, setCloneFromModal] = useState(false)
  const [cloneFromSource, setCloneFromSource] = useState('')
  const [cloningFrom, startCloneFrom] = useTransition()

  const toggleAllPhotos = () => {
    const totalItems = sections.reduce((n, s) => n + s.items.length, 0)
    const photoItems = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
    const newValue   = !(totalItems > 0 && photoItems === totalItems)
    setSections((prev) => prev.map((s) => ({
      ...s,
      items: s.items.map((item) => ({ ...item, requires_photo: newValue })),
    })))
  }

  const toggleSectionPhotos = (sectionTempId: string) => {
    setSections((prev) => prev.map((s) => {
      if (s.tempId !== sectionTempId) return s
      const newValue = !s.items.every((i) => i.requires_photo)
      return { ...s, items: s.items.map((item) => ({ ...item, requires_photo: newValue })) }
    }))
  }

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

  const handleBroadcast = () => {
    if (broadcastTargets.size === 0) return
    startBroadcast(async () => {
      const result = await broadcastChecklistTemplate(propertyId, Array.from(broadcastTargets))
      if (result.error) {
        setError(result.error)
      } else {
        setBroadcastResult(`Applied to ${result.broadcast} propert${result.broadcast !== 1 ? 'ies' : 'y'}.`)
        setTimeout(() => setBroadcastResult(null), 4000)
      }
      setBroadcastModal(false)
      setBroadcastTargets(new Set())
    })
  }

  const handleCloneFrom = () => {
    if (!cloneFromSource) return
    startCloneFrom(async () => {
      const result = await cloneChecklistFromProperty(cloneFromSource, propertyId)
      if (result.error) { setError(result.error); return }
      setCloneFromModal(false)
      window.location.reload()
    })
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
    <div className="space-y-4" suppressHydrationWarning>
      {error && (
        <div className="border text-sm rounded-lg px-4 py-3" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{error}</div>
      )}

      {/* Global photo requirement toggle */}
      {sections.some((s) => s.items.length > 0) && (() => {
        const totalItems = sections.reduce((n, s) => n + s.items.length, 0)
        const photoItems = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
        const allOn      = totalItems > 0 && photoItems === totalItems

        return (
          <div className="flex items-center justify-between px-4 py-3 bg-canvas-themed rounded-xl border border-themed mb-4">
            <div className="flex items-center gap-2">
              <Camera className="w-4 h-4 text-muted-themed" />
              <div>
                <p className="text-sm font-medium text-primary-themed">Require photo proof for all tasks</p>
                <p className="text-xs text-muted-themed">{photoItems} of {totalItems} tasks require a photo</p>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleAllPhotos}
              className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none"
              style={{ background: allOn ? 'var(--accent-gold)' : 'var(--border-strong)' }}
              role="switch"
              aria-checked={allOn}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${allOn ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        )
      })()}

      {sections.map((section, si) => (
        <div key={section.tempId} className="border border-themed rounded-xl overflow-hidden">
          {/* Section header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-themed" style={{ background: 'var(--bg-raised)' }}>
            <input
              value={section.name}
              onChange={(e) => updateSection(section.tempId, e.target.value)}
              className="flex-1 text-sm font-semibold bg-transparent text-primary-themed focus:outline-none border-b border-transparent focus:border-[var(--accent-gold)]"
            />
            <div className="flex items-center gap-0.5 ml-auto">
              {(() => {
                const sectionAllPhoto = section.items.length > 0 &&
                  section.items.every((i) => i.requires_photo)
                return (
                  <button
                    type="button"
                    onClick={() => toggleSectionPhotos(section.tempId)}
                    title={sectionAllPhoto
                      ? 'Remove photo requirement for all items in this section'
                      : 'Require photo for all items in this section'}
                    className={sectionAllPhoto ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                    style={sectionAllPhoto ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                )
              })()}
              <button onClick={() => moveSection(section.tempId, -1)} disabled={si === 0} className="btn-ghost p-1 disabled:opacity-30">
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => moveSection(section.tempId, 1)} disabled={si === sections.length - 1} className="btn-ghost p-1 disabled:opacity-30">
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => removeSection(section.tempId)} className="btn-ghost p-1 text-muted-themed hover:text-red-500">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Items */}
          <div className="divide-y divide-themed">
            {section.items.map((item, ii) => (
              <div key={item.tempId} className="flex items-center gap-2 px-4 py-2.5 group hover:bg-raised-themed">
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
                  className="flex-1 text-sm text-primary-themed bg-transparent focus:outline-none placeholder:text-[var(--text-muted)]"
                />
                <button
                  onClick={() => updateItem(section.tempId, item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={item.requires_photo ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                  style={item.requires_photo ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button onClick={() => removeItem(section.tempId, item.tempId)} className="text-muted-themed hover:text-red-500 transition-colors p-1 opacity-0 group-hover:opacity-100">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Add item */}
          <button
            onClick={() => addItem(section.tempId)}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-muted-themed hover:text-[var(--accent-gold)] hover:bg-[var(--accent-gold-dim)] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add task
          </button>
        </div>
      ))}

      <button onClick={addSection} className="btn-secondary w-full justify-center border-dashed">
        <Plus className="w-4 h-4" /> Add Section
      </button>

      {broadcastResult && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm border" style={{ background: 'var(--accent-green-dim)', borderColor: 'var(--accent-green)', color: 'var(--accent-green)' }}>
          <Check className="w-4 h-4 flex-shrink-0" />
          {broadcastResult}
        </div>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-themed flex-wrap">
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
        {sourceProperties.length > 0 && (
          <button
            type="button"
            onClick={() => setCloneFromModal(true)}
            className="btn-secondary text-xs ml-auto"
          >
            Clone from property…
          </button>
        )}
        {otherProperties.length > 0 && (
          <button
            type="button"
            onClick={() => setBroadcastModal(true)}
            className={sourceProperties.length > 0 ? 'btn-secondary text-xs' : 'btn-secondary text-xs ml-auto'}
          >
            📋 Apply to Other Properties
          </button>
        )}
      </div>

      {broadcastModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-card-themed rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-themed">
              <h3 className="font-semibold text-primary-themed">Apply to Other Properties</h3>
              <button onClick={() => setBroadcastModal(false)} className="p-1.5 rounded-lg text-muted-themed hover:text-primary-themed">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-2 max-h-60 overflow-y-auto">
              <p className="text-xs text-muted-themed mb-3">
                This will replace the existing checklist at each selected property.
              </p>
              {otherProperties.map(p => (
                <label key={p.id} className="flex items-center gap-3 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={broadcastTargets.has(p.id)}
                    onChange={e => {
                      const next = new Set(broadcastTargets)
                      if (e.target.checked) next.add(p.id)
                      else next.delete(p.id)
                      setBroadcastTargets(next)
                    }}
                    className="w-4 h-4 rounded"
                    style={{ accentColor: 'var(--accent-gold)' }}
                  />
                  <span className="text-sm text-primary-themed">{p.name}</span>
                </label>
              ))}
            </div>
            <div className="px-5 pb-5 pt-3 border-t border-themed flex gap-3">
              <button
                onClick={handleBroadcast}
                disabled={broadcasting || broadcastTargets.size === 0}
                className="btn-primary flex-1 text-sm"
              >
                {broadcasting ? 'Applying…' : `Apply to ${broadcastTargets.size} propert${broadcastTargets.size !== 1 ? 'ies' : 'y'}`}
              </button>
              <button onClick={() => setBroadcastModal(false)} className="btn-ghost text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {cloneFromModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-sm p-6">
            <h3 className="font-semibold text-primary-themed mb-1">Import Checklist From</h3>
            <p className="text-xs text-muted-themed mb-1">
              This will replace the current checklist entirely with a copy from the selected property.
            </p>
            <p className="text-xs font-semibold mb-4" style={{ color: 'var(--accent-amber)' }}>
              ⚠ Any existing checklist on this property will be overwritten.
            </p>
            <select
              value={cloneFromSource}
              onChange={e => setCloneFromSource(e.target.value)}
              className="input w-full mb-4"
            >
              <option value="">Select a property…</option>
              {sourceProperties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sectionCount} sections)
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={handleCloneFrom}
                disabled={!cloneFromSource || cloningFrom}
                className="btn-primary flex-1"
              >
                {cloningFrom ? 'Importing…' : 'Import Checklist'}
              </button>
              <button onClick={() => setCloneFromModal(false)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
