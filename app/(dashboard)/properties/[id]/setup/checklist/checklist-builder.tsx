'use client'

import { useState, useTransition, useRef } from 'react'
import { saveChecklistTemplate, completeChecklistStep, broadcastChecklistTemplate, cloneChecklistFromProperty } from './actions'
import { Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Camera, Check, ClipboardList, AlertTriangle, Upload, Home, Link2, Minus } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'

interface Item { tempId: string; id?: string; task: string; requires_photo: boolean; notes: string }
interface Section { tempId: string; id?: string; name: string; roomTemplateId?: string | null; items: Item[] }

interface RoomTemplateOption {
  id: string
  name: string
  autoInclude: boolean
  items: Array<{ task: string; requires_photo: boolean; notes: string | null }>
}

function makeId() {
  if (typeof window === 'undefined') return 'ssr'
  return crypto.randomUUID()
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

function buildInitialSections(template: { checklist_template_sections?: Array<{ id: string; name: string; sort_order: number; room_template_id?: string | null; checklist_template_items?: Array<{ id: string; task: string; requires_photo: boolean; notes: string | null; sort_order: number }> }> } | null): Section[] {
  if (!template?.checklist_template_sections?.length) return DEFAULT_SECTIONS

  return [...template.checklist_template_sections]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({
      tempId: makeId(),
      id: s.id,
      name: s.name,
      roomTemplateId: s.room_template_id ?? null,
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

function makeSectionFromRoom(room: RoomTemplateOption, label: string): Section {
  return {
    tempId: makeId(),
    name: label,
    roomTemplateId: room.id,
    items: room.items.map((item) => ({
      tempId: makeId(),
      task: item.task,
      requires_photo: item.requires_photo,
      notes: item.notes ?? '',
    })),
  }
}

// Rooms flagged auto-include (e.g. "Whole Home") belong on every property's
// checklist regardless of what the PM has picked — seed any missing ones in
// alongside whatever sections the template/defaults already provide.
function withAutoIncludeRooms(sections: Section[], roomTemplates: RoomTemplateOption[]): Section[] {
  const missing = roomTemplates.filter(
    (room) => room.autoInclude && !sections.some((s) => s.roomTemplateId === room.id)
  )
  if (missing.length === 0) return sections
  return [...sections, ...missing.map((room) => makeSectionFromRoom(room, room.name))]
}

interface OtherProperty { id: string; name: string }
interface SourceProperty { id: string; name: string; sectionCount: number }

export function ChecklistBuilder({
  propertyId,
  template,
  otherProperties = [],
  sourceProperties = [],
  roomTemplates = [],
}: {
  propertyId: string
  template: { id: string; name: string; checklist_template_sections?: Array<{ id: string; name: string; sort_order: number; room_template_id?: string | null; checklist_template_items?: Array<{ id: string; task: string; requires_photo: boolean; notes: string | null; sort_order: number }> }> } | null
  otherProperties?: OtherProperty[]
  sourceProperties?: SourceProperty[]
  roomTemplates?: RoomTemplateOption[]
}) {
  const [sections, setSections] = useState<Section[]>(() =>
    withAutoIncludeRooms(buildInitialSections(template), roomTemplates)
  )
  const [saving, startSave] = useTransition()
  const [completing, startComplete] = useTransition()
  const [broadcasting, startBroadcast] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roomPickerOpen, setRoomPickerOpen] = useState(false)
  const [roomQuantities, setRoomQuantities] = useState<Record<string, number>>({})
  const [expandedRoomIds, setExpandedRoomIds] = useState<Set<string>>(new Set())
  const [broadcastModal, setBroadcastModal] = useState(false)
  const [broadcastTargets, setBroadcastTargets] = useState<Set<string>>(new Set())
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null)
  const [cloneFromModal, setCloneFromModal] = useState(false)
  const [cloneFromSource, setCloneFromSource] = useState('')
  const [cloningFrom, startCloneFrom] = useTransition()

  // Import (CSV / DOCX) state
  const [showImport, setShowImport]         = useState(false)
  const [importPreview, setImportPreview]   = useState<Array<{ section: string; task: string }>>([])
  const csvImportRef                        = useRef<HTMLInputElement | null>(null)

  const parseCsvImport = (text: string): Array<{ section: string; task: string }> => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return []
    const header    = lines[0].toLowerCase()
    const hasHeader = header.includes('section') || header.includes('task')
    const data      = hasHeader ? lines.slice(1) : lines
    return data
      .map((line) => {
        const cols    = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        const section = cols.length >= 2 ? (cols[0] ?? 'Imported') : 'Imported'
        const task    = cols.length >= 2 ? (cols[1] ?? '') : (cols[0] ?? '')
        return { section, task }
      })
      .filter((r) => r.task)
  }

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (file.name.endsWith('.docx')) {
      try {
        const mammoth       = await import('mammoth')
        const buf           = await file.arrayBuffer()
        const { value }     = await mammoth.extractRawText({ arrayBuffer: buf })
        let currentSection  = 'Imported'
        const parsed: Array<{ section: string; task: string }> = []
        for (const line of value.split('\n').map((l) => l.trim()).filter(Boolean)) {
          if (line.length < 60 && !line.endsWith('.') && !line.startsWith('-')) {
            currentSection = line
          } else {
            parsed.push({ section: currentSection, task: line.replace(/^[-•·]\s*/, '') })
          }
        }
        setImportPreview(parsed.filter((p) => p.task))
      } catch {
        setError('Could not parse DOCX. Try a CSV instead.')
      }
    } else {
      const reader  = new FileReader()
      reader.onload = (ev) => setImportPreview(parseCsvImport(ev.target?.result as string))
      reader.readAsText(file)
    }
  }

  const confirmImport = () => {
    if (!importPreview.length) return
    setSections((prev) => {
      const next = prev.map((s) => ({ ...s, items: [...s.items] }))
      for (const { section: sectionName, task } of importPreview) {
        const existing = next.find(
          (s) => s.name.toLowerCase() === sectionName.toLowerCase()
        )
        if (existing) {
          existing.items.push({ tempId: makeId(), task, requires_photo: false, notes: '' })
        } else {
          next.push({
            tempId: makeId(),
            name:   sectionName,
            items:  [{ tempId: makeId(), task, requires_photo: false, notes: '' }],
          })
        }
      }
      return next
    })
    setImportPreview([])
    setShowImport(false)
  }

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

  // Auto-include rooms (e.g. "Whole Home") aren't offered here — they're
  // already seeded automatically and aren't a per-quantity, opt-in choice.
  const pickerRoomTemplates = roomTemplates.filter((room) => !room.autoInclude)

  const applyRoomQuantities = () => {
    setSections((prev) => {
      const next = [...prev]
      for (const room of pickerRoomTemplates) {
        const targetCount = roomQuantities[room.id] ?? 0
        if (targetCount <= 0) continue
        const currentCount = next.filter((s) => s.roomTemplateId === room.id).length
        for (let i = currentCount + 1; i <= targetCount; i++) {
          const label = targetCount > 1 ? `${room.name} ${i}` : room.name
          next.push(makeSectionFromRoom(room, label))
        }
      }
      return next
    })
    setRoomQuantities({})
    setExpandedRoomIds(new Set())
    setRoomPickerOpen(false)
  }

  const toggleRoomExpanded = (roomId: string) => {
    setExpandedRoomIds((prev) => {
      const next = new Set(prev)
      if (next.has(roomId)) next.delete(roomId)
      else next.add(roomId)
      return next
    })
  }

  const setRoomQuantity = (roomId: string, qty: number) => {
    setRoomQuantities((prev) => ({ ...prev, [roomId]: Math.max(0, qty) }))
  }

  const detachSectionFromRoom = (tempId: string) => {
    setSections((p) => p.map((s) => s.tempId === tempId ? { ...s, roomTemplateId: null } : s))
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
        room_template_id: s.roomTemplateId ?? null,
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
            {section.roomTemplateId && (
              <button
                type="button"
                onClick={() => detachSectionFromRoom(section.tempId)}
                title="Linked to a room template — click to detach and customize freely"
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0"
                style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
              >
                <Link2 className="w-3 h-3" /> Linked
              </button>
            )}
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
              <Button variant="ghost" onClick={() => moveSection(section.tempId, -1)} disabled={si === 0} className="p-1 disabled:opacity-30">
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" onClick={() => moveSection(section.tempId, 1)} disabled={si === sections.length - 1} className="p-1 disabled:opacity-30">
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" onClick={() => removeSection(section.tempId)} className="p-1 text-muted-themed hover:text-red-500">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {/* Items */}
          <div className="divide-y divide-themed">
            {section.items.map((item, ii) => (
              <div key={item.tempId} className="flex items-center gap-2 px-4 py-2.5 group hover:bg-raised-themed">
                <div className="flex gap-0.5">
                  <Button variant="ghost" onClick={() => moveItem(section.tempId, item.tempId, -1)} disabled={ii === 0} className="p-0.5 disabled:opacity-30">
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" onClick={() => moveItem(section.tempId, item.tempId, 1)} disabled={ii === section.items.length - 1} className="p-0.5 disabled:opacity-30">
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </div>
                <input
                  value={item.task}
                  onChange={(e) => updateItem(section.tempId, item.tempId, 'task', e.target.value)}
                  placeholder="Task description…"
                  className="flex-1 text-sm text-primary-themed bg-transparent focus:outline-none placeholder:text-[var(--text-muted)] border-b border-[color:var(--border)] focus:border-[var(--accent-gold)] transition-colors"
                />
                <button
                  onClick={() => updateItem(section.tempId, item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={item.requires_photo ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                  style={item.requires_photo ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button onClick={() => removeItem(section.tempId, item.tempId)} className="text-muted-themed hover:text-red-500 transition-colors p-1">
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

      {/* Hidden file input for CSV/DOCX import */}
      <input
        type="file"
        accept=".csv,.docx"
        ref={csvImportRef}
        className="hidden"
        onChange={handleImportFileChange}
      />

      {showImport ? (
        <div className="border border-themed rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-primary-themed">Import Tasks</p>
            <button
              type="button"
              onClick={() => { setShowImport(false); setImportPreview([]) }}
              className="text-xs text-muted-themed hover:underline"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Upload a <strong>.csv</strong> (columns: <code>Section, Task</code>) or <strong>.docx</strong>{' '}
            (headings become sections, bullet lines become tasks).
          </p>
          {importPreview.length === 0 ? (
            <button
              type="button"
              onClick={() => csvImportRef.current?.click()}
              className="w-full border-2 border-dashed border-themed rounded-xl py-6 text-sm flex flex-col items-center gap-2 transition-colors hover:border-strong-themed"
              style={{ color: 'var(--text-muted)' }}
            >
              <Upload className="w-5 h-5" />
              Click to upload CSV or DOCX
            </button>
          ) : (
            <>
              <div className="border border-themed rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                {importPreview.map((row, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-4 py-2 border-b border-themed last:border-0 text-sm"
                  >
                    <span className="text-xs font-medium text-muted-themed w-28 flex-shrink-0 truncate">
                      {row.section}
                    </span>
                    <span className="text-primary-themed">{row.task}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button type="button" onClick={confirmImport} className="flex-1 text-sm">
                  Add {importPreview.length} tasks
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setImportPreview([])}
                  className="text-sm"
                >
                  Clear
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          {pickerRoomTemplates.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRoomPickerOpen(true)}
              className="flex-1 justify-center border-dashed inline-flex items-center gap-1.5"
            >
              <Home className="w-4 h-4" /> Insert Rooms from Library
            </Button>
          )}
          <Button variant="secondary" onClick={addSection} className="flex-1 justify-center border-dashed">
            <Plus className="w-4 h-4" /> Add Custom Section
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowImport(true)}
            className="px-3"
            title="Import tasks from CSV or DOCX"
          >
            <Upload className="w-4 h-4" />
          </Button>
        </div>
      )}

      {broadcastResult && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm border" style={{ background: 'var(--accent-green-dim)', borderColor: 'var(--accent-green)', color: 'var(--accent-green)' }}>
          <Check className="w-4 h-4 flex-shrink-0" />
          {broadcastResult}
        </div>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-themed flex-wrap">
        <Button variant="secondary" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5">
          {saving ? 'Saving…' : saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save Checklist'}
        </Button>
        <Button
          disabled={completing}
          onClick={() =>
            startComplete(async () => {
              const payload = sections.map((s, si) => ({
                id:         s.id,
                name:       s.name,
                sort_order: si,
                room_template_id: s.roomTemplateId ?? null,
                items:      s.items.map((item, ii) => ({
                  id:             item.id,
                  task:           item.task,
                  requires_photo: item.requires_photo,
                  notes:          item.notes,
                  sort_order:     ii,
                })),
              }))
              const saveResult = await saveChecklistTemplate(
                propertyId,
                template?.id ?? null,
                payload
              )
              if (saveResult.error) { setError(saveResult.error); return }
              await completeChecklistStep(propertyId)
            })
          }
        >
          {completing ? 'Saving…' : 'Save & Continue →'}
        </Button>
        {sourceProperties.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setCloneFromModal(true)}
            className="text-xs ml-auto"
          >
            Clone from property…
          </Button>
        )}
        {otherProperties.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setBroadcastModal(true)}
            className={`inline-flex items-center gap-1.5 text-xs ${sourceProperties.length > 0 ? '' : 'ml-auto'}`}
          >
            <ClipboardList className="w-3.5 h-3.5" /> Apply to Other Properties
          </Button>
        )}
      </div>

      <Dialog open={broadcastModal} onClose={() => setBroadcastModal(false)} title="Apply to Other Properties" maxWidthClassName="max-w-sm">
        <div className="space-y-2 max-h-60 overflow-y-auto">
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
        <div className="pt-3 mt-3 border-t border-themed flex gap-3">
          <Button
            onClick={handleBroadcast}
            disabled={broadcasting || broadcastTargets.size === 0}
            className="flex-1 text-sm"
          >
            {broadcasting ? 'Applying…' : `Apply to ${broadcastTargets.size} propert${broadcastTargets.size !== 1 ? 'ies' : 'y'}`}
          </Button>
          <Button variant="ghost" onClick={() => setBroadcastModal(false)} className="text-sm">Cancel</Button>
        </div>
      </Dialog>

      <Dialog open={cloneFromModal} onClose={() => setCloneFromModal(false)} title="Import Checklist From" maxWidthClassName="max-w-sm">
        <p className="text-xs text-muted-themed mb-1">
          This will replace the current checklist entirely with a copy from the selected property.
        </p>
        <p className="text-xs font-semibold mb-4 flex items-center gap-1.5" style={{ color: 'var(--accent-amber)' }}>
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Any existing checklist on this property will be overwritten.
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
          <Button
            onClick={handleCloneFrom}
            disabled={!cloneFromSource || cloningFrom}
            className="flex-1"
          >
            {cloningFrom ? 'Importing…' : 'Import Checklist'}
          </Button>
          <Button variant="ghost" onClick={() => setCloneFromModal(false)}>Cancel</Button>
        </div>
      </Dialog>

      <Dialog open={roomPickerOpen} onClose={() => setRoomPickerOpen(false)} title="Insert Rooms from Library" maxWidthClassName="max-w-lg">
        <p className="text-xs text-muted-themed mb-4">
          Check the room types this property has and set how many of each —
          click a room&apos;s name to preview its checklist first. A section
          gets added per room, pre-filled with its tasks — rename them
          afterward (e.g. &quot;Primary Bedroom&quot;) if you&apos;d like.
        </p>
        <div className="border border-themed rounded-lg divide-y divide-themed max-h-96 overflow-y-auto">
          {pickerRoomTemplates.map((room) => {
            const existingCount = sections.filter((s) => s.roomTemplateId === room.id).length
            const qty = roomQuantities[room.id] ?? 0
            const isExpanded = expandedRoomIds.has(room.id)
            return (
              <div key={room.id}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <Checkbox
                    checked={qty > 0}
                    onChange={(e) => setRoomQuantity(room.id, e.target.checked ? 1 : 0)}
                    aria-label={`Include ${room.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => toggleRoomExpanded(room.id)}
                    className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                  >
                    <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 transition-transform text-muted-themed ${isExpanded ? 'rotate-90' : ''}`} />
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-primary-themed truncate block">{room.name}</span>
                      {existingCount > 0 && (
                        <span className="text-xs text-muted-themed block">{existingCount} already on this property</span>
                      )}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setRoomQuantity(room.id, qty - 1)}
                      disabled={qty === 0}
                      className="p-1 disabled:opacity-30"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </Button>
                    <input
                      type="number"
                      min={0}
                      value={qty}
                      onChange={(e) => setRoomQuantity(room.id, parseInt(e.target.value, 10) || 0)}
                      aria-label={`Quantity for ${room.name}`}
                      className="w-12 text-center text-sm font-semibold text-primary-themed bg-transparent border border-themed rounded focus:outline-none focus:border-[var(--accent-gold)]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setRoomQuantity(room.id, qty + 1)}
                      className="p-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="pl-9 pr-3 pb-3">
                    <ul className="text-xs text-muted-themed list-disc list-inside space-y-1">
                      {room.items.map((item) => (
                        <li key={item.task}>{item.task}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="pt-3 mt-3 border-t border-themed flex gap-3">
          <Button
            onClick={applyRoomQuantities}
            disabled={Object.values(roomQuantities).every((q) => !q)}
            className="flex-1 text-sm"
          >
            Add Rooms
          </Button>
          <Button
            variant="ghost"
            onClick={() => { setRoomQuantities({}); setExpandedRoomIds(new Set()); setRoomPickerOpen(false) }}
            className="text-sm"
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
