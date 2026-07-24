'use client'

import { useRef, useState, useTransition } from 'react'
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react'
import { cn, INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Tabs } from '@/components/ui/Tabs'
import { createInventoryTemplate, createInventoryTemplateFromCSV } from '../actions'
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

// ── CSV parsing ──────────────────────────────────────────────────────────────
// Reuses the quoted-field column-splitting approach already established in
// vendors-client.tsx / crew-manage-client.tsx's parseCSV — no new parsing
// dependency. Adapted for this screen's five columns instead of vendor
// fields. Unlike those two files, there's no "Paste from Doc" free-text
// mode here — vendor/crew rows can be pulled from unstructured text via
// regex (an email or phone number is a reliable anchor), but there's no
// equivalent anchor for "name, category, unit, par level, brand" — so the
// second input mode is "paste CSV text" (the same structured format, just
// typed/pasted instead of uploaded) rather than free-form doc text.

const CATEGORY_VALUES = Object.keys(INVENTORY_CATEGORY_LABELS) as InventoryCategory[]

interface ParsedCSVRow {
  name:            string
  categoryRaw:     string
  category:        InventoryCategory
  categoryInvalid: boolean
  unit:            string
  par_level:       number
  preferred_brand: string | null
}

function splitCSVLine(line: string): string[] {
  return (line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) ?? line.split(','))
    .map((c) => c.replace(/^"|"$/g, '').trim())
}

function normalizeCategory(raw: string): { category: InventoryCategory; invalid: boolean } {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_')
  const match = CATEGORY_VALUES.find((v) => v === key)
  return match ? { category: match, invalid: false } : { category: 'other', invalid: true }
}

function parseInventoryCSV(text: string): ParsedCSVRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []

  const headers  = lines[0].toLowerCase().split(',').map((h) => h.trim())
  const nameIdx  = headers.findIndex((h) => h.includes('name'))
  const catIdx   = headers.findIndex((h) => h.includes('cat'))
  const unitIdx  = headers.findIndex((h) => h.includes('unit'))
  const parIdx   = headers.findIndex((h) => h.includes('par') || h.includes('level'))
  const brandIdx = headers.findIndex((h) => h.includes('brand'))
  const hasHeader = nameIdx >= 0 || catIdx >= 0 || unitIdx >= 0
  const dataLines = hasHeader ? lines.slice(1) : lines

  return dataLines
    .map((line) => {
      const cols = splitCSVLine(line)
      const name = nameIdx >= 0 ? (cols[nameIdx] ?? '') : (cols[0] ?? '')
      const categoryRaw = catIdx >= 0 ? (cols[catIdx] ?? '') : ''
      const { category, invalid } = normalizeCategory(categoryRaw || 'other')
      const parRaw = parIdx >= 0 ? cols[parIdx] : undefined
      const parParsed = parRaw ? parseFloat(parRaw) : NaN
      return {
        name,
        categoryRaw:     categoryRaw || 'other',
        category,
        categoryInvalid: invalid,
        unit:            unitIdx >= 0 ? (cols[unitIdx] || 'units') : 'units',
        // Number.isFinite guard, not `|| 1` — an explicit "0" in the CSV is
        // a real par_level of zero, not a falsy placeholder to fall back on.
        par_level:       Number.isFinite(parParsed) ? parParsed : 1,
        preferred_brand: brandIdx >= 0 ? (cols[brandIdx] || null) : null,
      }
    })
    .filter((r) => r.name)
}

export function CreateTemplateBuilder({
  catalogItems,
  properties,
}: Readonly<{ catalogItems: CatalogItem[]; properties: Property[] }>) {
  const [mode, setMode] = useState<'select' | 'csv'>('select')

  // Checkbox-select mode
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [brandByItemId, setBrandByItemId] = useState<Record<string, string>>({})

  // CSV mode
  const [csvInputMode, setCsvInputMode] = useState<'file' | 'paste'>('file')
  const [pasteText, setPasteText] = useState('')
  const [csvRows, setCsvRows] = useState<ParsedCSVRow[]>([])
  const [csvParseError, setCsvParseError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleCsvFile = (file: File) => {
    setCsvParseError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const rows = parseInventoryCSV((ev.target?.result as string) ?? '')
      if (!rows.length) { setCsvParseError('No valid rows found in that file.'); return }
      setCsvRows(rows)
    }
    reader.readAsText(file)
  }

  const handleParsePaste = () => {
    setCsvParseError(null)
    const rows = parseInventoryCSV(pasteText)
    if (!rows.length) { setCsvParseError('No valid rows found in that text.'); return }
    setCsvRows(rows)
  }

  const clearCsv = () => {
    setCsvRows([])
    setCsvParseError(null)
    setPasteText('')
    if (fileInputRef.current) fileInputRef.current.value = ''
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
      const result = mode === 'csv'
        ? await createInventoryTemplateFromCSV(
            templateName.trim(),
            csvRows.map((r) => ({
              name:             r.name,
              category:         r.category,
              unit:             r.unit,
              par_level:        r.par_level,
              preferred_brand:  r.preferred_brand,
            }))
          )
        : await createInventoryTemplate(
            templateName.trim(),
            Array.from(selected),
            brandByItemId
          )
      if (result.error || !result.templateId) {
        setCreateError(result.error ?? 'Failed to create template.')
        return
      }
      setCreatedTemplateId(result.templateId)
      setCreatedTemplateName(templateName.trim())
      setSelected(new Set())
      setBrandByItemId({})
      clearCsv()
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

  const readyCount = mode === 'csv' ? csvRows.length : selected.size

  return (
    <div className="space-y-4">
      <Tabs
        tabs={[
          { id: 'select', label: 'From Master List' },
          { id: 'csv',    label: 'From CSV' },
        ]}
        active={mode}
        onChange={setMode}
      />

      {mode === 'select' ? (
        <>
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
                  {categoryItems.map((item) => {
                    const isChecked = selected.has(item.id)
                    return (
                      <div key={item.id} className="flex items-center gap-2 px-4 py-2">
                        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <Checkbox checked={isChecked} onChange={() => toggleItem(item.id)} />
                          <span className="text-sm text-primary-themed truncate">{item.name}</span>
                          <span className="text-xs text-muted-themed flex-shrink-0">{item.default_unit}</span>
                        </label>
                        {isChecked && (
                          <input
                            value={brandByItemId[item.id] ?? ''}
                            onChange={(e) => setBrandByItemId((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            placeholder="Brand (optional)"
                            aria-label={`Preferred brand for ${item.name}`}
                            className="text-xs border border-themed rounded px-2 py-1 bg-transparent text-primary-themed placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-gold)] w-36 flex-shrink-0"
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setCsvInputMode('file'); clearCsv() }}
              className={cn('flex-1 text-sm rounded-lg px-3 py-2 border text-center', csvInputMode === 'file' ? 'font-medium' : 'border-themed text-secondary-themed')}
              style={csvInputMode === 'file' ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
            >
              CSV File
            </button>
            <button
              type="button"
              onClick={() => { setCsvInputMode('paste'); clearCsv() }}
              className={cn('flex-1 text-sm rounded-lg px-3 py-2 border text-center', csvInputMode === 'paste' ? 'font-medium' : 'border-themed text-secondary-themed')}
              style={csvInputMode === 'paste' ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
            >
              Paste CSV
            </button>
          </div>

          <p className="text-xs text-muted-themed">
            Columns: <code>name</code> (required), <code>category</code>, <code>unit</code>, <code>par_level</code>, <code>preferred_brand</code> — header row optional.
          </p>

          {csvParseError && <InlineAlert tone="error">{csvParseError}</InlineAlert>}

          {csvRows.length === 0 && (
            csvInputMode === 'file' ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvFile(f) }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-themed rounded-xl py-6 text-sm flex flex-col items-center gap-2 transition-colors hover:border-strong-themed"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Upload className="w-5 h-5" />
                  Click to upload CSV
                </button>
              </>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={6}
                  className="input w-full text-xs font-mono"
                  placeholder={'name,category,unit,par_level,preferred_brand\nDish Soap,kitchen,bottles,2,Dawn'}
                />
                <Button variant="secondary" onClick={handleParsePaste} disabled={!pasteText.trim()} className="text-sm">
                  Parse
                </Button>
              </div>
            )
          )}

          {csvRows.length > 0 && (
            <>
              <div className="border border-themed rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ background: 'var(--bg-raised)' }}>
                      <th className="text-left px-3 py-2 text-muted-themed">Name</th>
                      <th className="text-left px-3 py-2 text-muted-themed">Category</th>
                      <th className="text-left px-3 py-2 text-muted-themed">Unit</th>
                      <th className="text-right px-3 py-2 text-muted-themed">Par</th>
                      <th className="text-left px-3 py-2 text-muted-themed">Brand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.map((row, i) => (
                      <tr key={i} className="border-t border-themed">
                        <td className="px-3 py-1.5 text-primary-themed">{row.name}</td>
                        <td className="px-3 py-1.5">
                          {row.categoryInvalid ? (
                            <span className="inline-flex items-center gap-1" style={{ color: 'var(--accent-amber)' }} title={`"${row.categoryRaw}" isn't a known category — will save as Other`}>
                              <AlertTriangle className="w-3 h-3" /> {row.categoryRaw} → Other
                            </span>
                          ) : (
                            <span className="text-secondary-themed">{INVENTORY_CATEGORY_LABELS[row.category]}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-secondary-themed">{row.unit}</td>
                        <td className="px-3 py-1.5 text-right text-secondary-themed">{row.par_level}</td>
                        <td className="px-3 py-1.5 text-secondary-themed">{row.preferred_brand ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="ghost" onClick={clearCsv} className="text-sm">Clear and start over</Button>
            </>
          )}
        </div>
      )}

      {readyCount > 0 && (
        <div className="flex justify-end pt-2">
          <Button onClick={() => setShowNameDialog(true)}>
            Save Template ({readyCount} item{readyCount !== 1 ? 's' : ''})
          </Button>
        </div>
      )}

      <Dialog
        open={showNameDialog}
        onClose={closeDialog}
        title={createdTemplateId ? 'Apply Template' : 'Name This Template'}
        maxWidthClassName="max-w-sm"
        footer={
          !createdTemplateId ? (
            <Button onClick={handleCreate} disabled={creating || !templateName.trim()} className="w-full">
              {creating ? 'Creating…' : 'Create Template'}
            </Button>
          ) : applyResult || properties.length === 0 ? (
            <Button onClick={closeDialog} className="w-full">Done</Button>
          ) : (
            <>
              <Button onClick={handleApply} disabled={applying || selectedPropertyIds.length === 0} className="flex-1">
                {applying ? 'Applying…' : `Apply to ${selectedPropertyIds.length || ''} propert${selectedPropertyIds.length === 1 ? 'y' : 'ies'}`}
              </Button>
              <Button variant="ghost" onClick={closeDialog}>Skip</Button>
            </>
          )
        }
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
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-themed -mt-2">&quot;{createdTemplateName}&quot; was created</p>

            {applyError && <InlineAlert tone="error">{applyError}</InlineAlert>}

            {applyResult ? (
              <InlineAlert tone="success" className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Applied — {applyResult.applied} item{applyResult.applied !== 1 ? 's' : ''} added across selected properties.</span>
              </InlineAlert>
            ) : properties.length === 0 ? (
              <p className="text-sm text-muted-themed">
                No properties to apply this template to yet. You can apply it later from Saved Templates.
              </p>
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
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
