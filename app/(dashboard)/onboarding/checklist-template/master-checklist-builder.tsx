'use client'

import { useState, useTransition, useRef } from 'react'
import { Plus, X, Upload, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { saveMasterChecklistItems, type ChecklistItemInput } from './actions'

// ── Seeded cleaning task catalog ─────────────────────────────────────────────

export const CLEANING_CATALOG: Record<string, string[]> = {
  'Kitchen': [
    'Wipe all countertops and backsplash',
    'Clean stovetop and burners',
    'Clean oven interior',
    'Clean microwave inside and out',
    'Wipe exterior of refrigerator',
    'Clean inside refrigerator, remove old items',
    'Run dishwasher or hand-wash dishes',
    'Empty and reline trash can',
    'Wipe cabinet fronts',
    'Sweep and mop floor',
    'Restock dish soap, sponge, paper towels',
  ],
  'Bathrooms': [
    'Scrub toilet bowl, seat, and base',
    'Clean sink and faucet',
    'Wipe mirror',
    'Scrub shower/tub and glass doors',
    'Sweep and mop floor',
    'Empty trash and reline',
    'Restock toilet paper, hand soap, shampoo/conditioner',
    'Replace bath mat if needed',
    'Wipe exhaust fan cover',
  ],
  'Bedrooms': [
    'Strip bed linens and pillowcases',
    'Make bed with fresh linens',
    'Dust furniture surfaces',
    'Wipe nightstands and lamps',
    'Vacuum floor and rugs',
    'Check under bed',
    'Empty trash',
    'Check closet and dresser drawers for left items',
    'Restock extra blankets/pillows if needed',
  ],
  'Living Areas': [
    'Dust all furniture',
    'Wipe TV screen and remotes',
    'Fluff and rearrange cushions',
    'Vacuum upholstered furniture',
    'Sweep and vacuum floors',
    'Mop hard floors',
    'Empty all trash',
    'Wipe light switches and door handles',
    'Check windows for smudges',
  ],
  'Laundry': [
    'Run all used towels and linens through washer/dryer',
    'Fold and return towels to bathrooms',
    'Wipe washer and dryer exteriors',
    'Clean lint trap',
  ],
  'Outdoor / Entry': [
    'Sweep front entry and porch',
    'Wipe outdoor furniture',
    'Remove any trash or debris from yard',
    'Check and clear grill grates',
    'Wipe door handles and keypad',
  ],
  'Final Checks': [
    'Check all windows are closed and locked',
    'Turn off all lights',
    'Set thermostat to default temperature',
    'Lock all doors',
    'Take photos of each room',
    'Report any damage or missing items',
  ],
}

const ALL_SECTIONS = Object.keys(CLEANING_CATALOG)

// ── Types ────────────────────────────────────────────────────────────────────

interface SelectedItem {
  section:    string
  task:       string
  sort_order: number
  source:     'catalog' | 'custom' | 'upload'
}

// ── Component ────────────────────────────────────────────────────────────────

export function MasterChecklistBuilder({
  existingItems,
  continueAction,
}: {
  existingItems: Array<{ id: string; section: string; task: string; sort_order: number; source: 'catalog' | 'custom' | 'upload' }>
  continueAction: () => Promise<void>
}) {
  const [tab, setTab]     = useState<'catalog' | 'custom' | 'upload'>('catalog')
  const [items, setItems] = useState<SelectedItem[]>(
    existingItems.map(({ section, task, sort_order, source }) => ({ section, task, sort_order, source }))
  )
  const [saving, startSave]   = useTransition()
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Catalog tab
  const [catalogSection, setCatalogSection] = useState<string>(ALL_SECTIONS[0]!)

  // Custom tab
  const [customSection, setCustomSection] = useState<string>(ALL_SECTIONS[0]!)
  const [customText, setCustomText]       = useState('')

  // Upload tab
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploadPreview, setUploadPreview] = useState<SelectedItem[]>([])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isTaskSelected = (section: string, task: string) =>
    items.some((i) => i.section === section && i.task === task)

  const toggleCatalogItem = (section: string, task: string) => {
    if (isTaskSelected(section, task)) {
      setItems((prev) => prev.filter((i) => !(i.section === section && i.task === task)))
    } else {
      setItems((prev) => [
        ...prev,
        { section, task, sort_order: prev.filter((i) => i.section === section).length, source: 'catalog' },
      ])
    }
  }

  const toggleAllInSection = (section: string) => {
    const tasks        = CLEANING_CATALOG[section] ?? []
    const allSelected  = tasks.every((t) => isTaskSelected(section, t))
    if (allSelected) {
      setItems((prev) => prev.filter((i) => i.section !== section))
    } else {
      const toAdd = tasks
        .filter((t) => !isTaskSelected(section, t))
        .map((t, idx) => ({
          section,
          task:       t,
          sort_order: items.filter((i) => i.section === section).length + idx,
          source:     'catalog' as const,
        }))
      setItems((prev) => [...prev, ...toAdd])
    }
  }

  const addCustomItems = () => {
    const lines = customText.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    const baseOrder = items.filter((i) => i.section === customSection).length
    setItems((prev) => [
      ...prev,
      ...lines.map((t, i) => ({ section: customSection, task: t, sort_order: baseOrder + i, source: 'custom' as const })),
    ])
    setCustomText('')
  }

  const parseUploadCsv = (text: string): SelectedItem[] => {
    const lines   = text.split(/\r?\n/).filter((l) => l.trim())
    if (!lines.length) return []
    const header  = lines[0].toLowerCase()
    const hasHeader = header.includes('section') || header.includes('task')
    const data    = hasHeader ? lines.slice(1) : lines
    return data.map((line, i) => {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      const section = cols.length >= 2 ? (cols[0] ?? 'General') : 'General'
      const task    = cols.length >= 2 ? (cols[1] ?? cols[0] ?? '') : (cols[0] ?? '')
      return { section, task, sort_order: i, source: 'upload' as const }
    }).filter((r) => r.task)
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (file.name.endsWith('.docx')) {
      try {
        // @ts-expect-error mammoth loaded via CDN / dynamic
        const mammoth = await import('mammoth')
        const buf = await file.arrayBuffer()
        const result = await mammoth.extractRawText({ arrayBuffer: buf })
        const lines = result.value.split('\n').map((l: string) => l.trim()).filter(Boolean)
        let currentSection = 'General'
        const parsed: SelectedItem[] = []
        for (const line of lines) {
          if (line.length < 50 && !line.endsWith('.') && !line.startsWith('-')) {
            currentSection = line
          } else {
            parsed.push({ section: currentSection, task: line.replace(/^[-•·]\s*/, ''), sort_order: parsed.length, source: 'upload' })
          }
        }
        setUploadPreview(parsed.filter((p) => p.task))
      } catch {
        setError('Could not parse DOCX. Try a CSV instead.')
      }
    } else {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const text = ev.target?.result as string
        setUploadPreview(parseUploadCsv(text))
      }
      reader.readAsText(file)
    }
  }

  const confirmUpload = () => {
    setItems((prev) => [...prev, ...uploadPreview])
    setUploadPreview([])
  }

  const handleSave = (andContinue = false) => {
    setError(null)
    startSave(async () => {
      const payload: ChecklistItemInput[] = items.map((item, i) => ({
        section:    item.section,
        task:       item.task,
        sort_order: i,
        source:     item.source,
      }))
      const result = await saveMasterChecklistItems(payload)
      if (result.error) {
        setError(result.error)
      } else {
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
        if (andContinue) await continueAction()
      }
    })
  }

  // Group selected items by section for preview
  const grouped = items.reduce<Record<string, SelectedItem[]>>((acc, item) => {
    if (!acc[item.section]) acc[item.section] = []
    acc[item.section]!.push(item)
    return acc
  }, {})

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: 'var(--bg-raised)' }}>
        {(['catalog', 'custom', 'upload'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={tab === t
              ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
              : { color: 'var(--text-muted)' }}
          >
            {t === 'catalog' ? 'From Catalog' : t === 'upload' ? 'Upload File' : 'Custom'}
          </button>
        ))}
      </div>

      {/* ── Catalog tab ─────────────────────────────────────────────────────── */}
      {tab === 'catalog' && (
        <div className="card p-4 space-y-4">
          {/* Section picker */}
          <div className="flex gap-1.5 flex-wrap">
            {ALL_SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setCatalogSection(s)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-full border transition-colors',
                  catalogSection === s
                    ? 'border-themed font-semibold'
                    : 'border-themed text-secondary-themed hover:text-primary-themed'
                )}
                style={catalogSection === s
                  ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)', borderColor: 'var(--accent-gold)' }
                  : {}}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Tasks list */}
          <div className="border border-themed rounded-xl overflow-hidden">
            {/* Select all header */}
            {(() => {
              const tasks      = CLEANING_CATALOG[catalogSection] ?? []
              const allChecked = tasks.every((t) => isTaskSelected(catalogSection, t))
              return (
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-themed"
                     style={{ background: 'var(--bg-raised)' }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() => toggleAllInSection(catalogSection)}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                    Select all in {catalogSection}
                  </span>
                </div>
              )
            })()}
            {(CLEANING_CATALOG[catalogSection] ?? []).map((task) => {
              const checked = isTaskSelected(catalogSection, task)
              return (
                <label
                  key={task}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer border-b border-themed last:border-0 transition-colors"
                  style={checked ? { background: 'var(--accent-gold-dim)' } : {}}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleCatalogItem(catalogSection, task)}
                    className="w-4 h-4 rounded flex-shrink-0"
                  />
                  <span className="text-sm text-primary-themed">{task}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Custom tab ──────────────────────────────────────────────────────── */}
      {tab === 'custom' && (
        <div className="card p-4 space-y-3">
          <div>
            <label className="label">Section</label>
            <select
              value={customSection}
              onChange={(e) => setCustomSection(e.target.value)}
              className="input"
            >
              {ALL_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="General">General</option>
            </select>
          </div>
          <div>
            <label className="label">Tasks (one per line)</label>
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={5}
              className="input resize-none font-mono text-sm"
              placeholder="Check appliances&#10;Vacuum rugs&#10;Wipe door handles"
            />
          </div>
          <button
            type="button"
            onClick={addCustomItems}
            disabled={!customText.trim()}
            className="btn-secondary text-sm flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" />
            Add to checklist
          </button>
        </div>
      )}

      {/* ── Upload tab ──────────────────────────────────────────────────────── */}
      {tab === 'upload' && (
        <div className="card p-4 space-y-3">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Upload a <strong>.csv</strong> (columns: <code>section, task</code>) or <strong>.docx</strong> (headings become sections).
          </p>
          <input type="file" accept=".csv,.docx" ref={fileRef} className="hidden" onChange={handleFileSelect} />

          {uploadPreview.length === 0 ? (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-themed rounded-xl py-8 text-sm flex flex-col items-center gap-2 transition-colors hover:border-strong-themed"
              style={{ color: 'var(--text-muted)' }}
            >
              <Upload className="w-6 h-6" />
              Click to upload CSV or DOCX
            </button>
          ) : (
            <>
              <div className="border border-themed rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                {uploadPreview.map((row, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-themed last:border-0 text-sm">
                    <span className="text-xs font-medium text-muted-themed w-28 flex-shrink-0">{row.section}</span>
                    <span className="text-primary-themed">{row.task}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={confirmUpload} className="btn-primary flex-1 text-sm">
                  Add {uploadPreview.length} tasks
                </button>
                <button type="button" onClick={() => setUploadPreview([])} className="btn-ghost text-sm">
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Selected items preview ───────────────────────────────────────────── */}
      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Selected ({items.length} tasks)
            </h3>
            <button
              type="button"
              onClick={() => setItems([])}
              className="text-xs"
              style={{ color: 'var(--accent-red)' }}
            >
              Clear all
            </button>
          </div>
          {Object.entries(grouped).map(([section, sectionItems]) => (
            <div key={section} className="border border-themed rounded-xl overflow-hidden">
              <div className="px-4 py-2 border-b border-themed" style={{ background: 'var(--bg-raised)' }}>
                <span className="text-xs font-semibold text-muted-themed uppercase">{section}</span>
              </div>
              {sectionItems.map((item, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-themed last:border-0">
                  <span className="flex-1 text-sm text-primary-themed">{item.task}</span>
                  <button
                    type="button"
                    onClick={() => setItems((prev) => prev.filter((p) => !(p.section === item.section && p.task === item.task)))}
                    className="text-muted-themed hover:text-red-500 transition-colors p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {error && (
        <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2 border-t border-themed">
        <button
          type="button"
          onClick={() => handleSave(true)}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save & Continue →'}
        </button>
        <button
          type="button"
          onClick={() => handleSave(false)}
          disabled={saving}
          className="btn-secondary"
        >
          Save Checklist
        </button>
        {success && (
          <span className="text-sm flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
      </div>
    </div>
  )
}
