'use client'

import { useState, useTransition, useRef } from 'react'
import { Plus, X, Upload, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { saveMasterChecklistItems, applyMasterChecklistToProperties, type ChecklistItemInput } from './actions'
import { CLEANING_CATALOG } from '@/lib/checklists/standard-catalog'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

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
  properties,
  continueAction,
}: {
  existingItems: Array<{ id: string; section: string; task: string; sort_order: number; source: 'catalog' | 'custom' | 'upload' }>
  properties:    Array<{ id: string; name: string }>
  continueAction: () => Promise<void>
}) {
  const [tab, setTab]     = useState<'catalog' | 'custom' | 'upload'>('catalog')
  const [items, setItems] = useState<SelectedItem[]>(
    existingItems.map(({ section, task, sort_order, source }) => ({ section, task, sort_order, source }))
  )
  const [saving, startSave]   = useTransition()
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Apply to all
  const [applying, startApply]    = useTransition()
  const [applyResult, setApplyResult] = useState<{ queued?: number; error?: string } | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

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

  const toggleAllCatalog = () => {
    const allTasks = ALL_SECTIONS.flatMap((s) => (CLEANING_CATALOG[s] ?? []).map((t) => ({ section: s, task: t })))
    const allSelected = allTasks.every(({ section, task }) => isTaskSelected(section, task))
    if (allSelected) {
      setItems((prev) => prev.filter((i) => i.source !== 'catalog'))
    } else {
      setItems((prev) => {
        const next = [...prev]
        for (const { section, task } of allTasks) {
          if (!next.some((i) => i.section === section && i.task === task)) {
            next.push({ section, task, sort_order: next.filter((i) => i.section === section).length, source: 'catalog' })
          }
        }
        return next
      })
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

  const handleApplyToAll = () => {
    setApplyResult(null)
    startApply(async () => {
      const ids = properties.map((p) => p.id)
      const result = await applyMasterChecklistToProperties(ids)
      setApplyResult(result)
      setShowConfirm(false)
    })
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
        <Card className="p-4 space-y-4">
          {/* Global select-all */}
          {(() => {
            const allTasks = ALL_SECTIONS.flatMap((s) => (CLEANING_CATALOG[s] ?? []).map((t) => ({ section: s, task: t })))
            const allSelected = allTasks.length > 0 && allTasks.every(({ section, task }) => isTaskSelected(section, task))
            return (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAllCatalog}
                  className="w-4 h-4 rounded"
                />
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Select all tasks ({allTasks.length})
                </span>
              </label>
            )
          })()}

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
        </Card>
      )}

      {/* ── Custom tab ──────────────────────────────────────────────────────── */}
      {tab === 'custom' && (
        <Card className="p-4 space-y-3">
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
          <Button
            type="button"
            onClick={addCustomItems}
            disabled={!customText.trim()}
            variant="secondary"
            className="text-sm flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" />
            Add to checklist
          </Button>
        </Card>
      )}

      {/* ── Upload tab ──────────────────────────────────────────────────────── */}
      {tab === 'upload' && (
        <Card className="p-4 space-y-3">
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
                <Button type="button" onClick={confirmUpload} className="flex-1 text-sm">
                  Add {uploadPreview.length} tasks
                </Button>
                <Button type="button" variant="ghost" onClick={() => setUploadPreview([])} className="text-sm">
                  Clear
                </Button>
              </div>
            </>
          )}
        </Card>
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
                    aria-label={`Remove ${item.task}`}
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
      <div className="space-y-3 pt-2 border-t border-themed">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => handleSave(true)}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save & Continue →'}
          </Button>
          <Button
            type="button"
            onClick={() => handleSave(false)}
            disabled={saving}
            variant="secondary"
          >
            Save Checklist
          </Button>
          {success && (
            <span className="text-sm flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
              <Check className="w-3.5 h-3.5" /> Saved
            </span>
          )}
        </div>

        {properties.length > 0 && (
          <div className="pt-1">
            <Button
              type="button"
              onClick={() => setShowConfirm(true)}
              disabled={applying || items.length === 0}
              variant="secondary"
              className="text-sm"
            >
              {applying ? 'Applying…' : `Apply to All Properties (${properties.length})`}
            </Button>
            {applyResult && (
              <p className="text-xs mt-1.5" style={{ color: applyResult.error ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                {applyResult.error ?? `Queued — applying to ${applyResult.queued} ${applyResult.queued === 1 ? 'property' : 'properties'} in the background`}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Confirm dialog ───────────────────────────────────────────────────── */}
      <Dialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Apply checklist to all properties?"
        maxWidthClassName="max-w-sm"
      >
        <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
          This will replace the default cleaning template on all {properties.length} {properties.length === 1 ? 'property' : 'properties'} with your current master checklist.
        </p>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Any customisations made per-property will be overwritten.
        </p>
        <div className="flex gap-3">
          <Button
            type="button"
            onClick={handleApplyToAll}
            disabled={applying}
            className="flex-1 text-sm"
          >
            {applying ? 'Applying…' : 'Yes, apply to all'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowConfirm(false)}
            className="text-sm"
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
