'use client'

import { useMemo, useRef, useState, useTransition, type ChangeEvent } from 'react'
import { Plus, Trash2, Check, Upload, FileText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { INVENTORY_CATEGORY_LABELS } from '@/lib/utils'
import {
  createCatalogItem, updateCatalogItem, deleteCatalogItem, bulkImportCatalogItems,
  type CatalogItemInput,
} from './actions'
import type { InventoryCategory, ParMode, ParSmartGroup } from '@/types/database'
import { PAR_SMART_GROUPS, resolvePar } from '@/lib/inventory/par-engine'

const CATEGORIES = Object.keys(INVENTORY_CATEGORY_LABELS) as InventoryCategory[]

// Sample property used to preview a smart-config formula in the admin UI —
// not a real property, just fixed inputs so the admin can see roughly what
// the formula produces before it ever reaches a real org.
const PREVIEW_PROPERTY = { bathrooms: 2, bedrooms: 3, max_guests: 6, avg_stay_length: 3 }

const MULTIPLIER_UNIT_LABEL: Record<ParSmartGroup, string> = {
  bathroom_essential: 'per bathroom',
  bedroom_essential:  'per bedroom',
  guest_consumable:   'per guest',
}

interface RowState {
  id:                string
  name:              string
  category:          InventoryCategory
  default_unit:      string
  default_par_level: number
  par_mode:          ParMode
  smart_group:       ParSmartGroup | null
  base_qty:          number
  description:       string
  is_active:         boolean
  dirty:             boolean
}

interface ParConfigValue {
  par_mode:          ParMode
  smart_group:       ParSmartGroup | null
  base_qty:          number
  default_par_level: number
}

function ParConfigFields({
  value,
  onChange,
}: Readonly<{
  value:    ParConfigValue
  onChange: (patch: Partial<ParConfigValue>) => void
}>) {
  const preview = value.smart_group
    ? resolvePar(
        { par_mode: 'smart', smart_group: value.smart_group, base_qty: value.base_qty, par_level: value.default_par_level, auto_adjust: false },
        PREVIEW_PROPERTY,
        null
      ).par
    : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={value.par_mode}
          onChange={(e) => {
            const par_mode = e.target.value as ParMode
            onChange(par_mode === 'smart' ? { par_mode, smart_group: value.smart_group ?? 'guest_consumable' } : { par_mode, smart_group: null })
          }}
          className="input text-sm"
          aria-label="Par mode"
        >
          <option value="static">Static</option>
          <option value="smart">Smart</option>
        </select>
        {value.par_mode === 'static' && (
          <input
            type="number"
            min={0}
            step="any"
            value={value.default_par_level}
            onChange={(e) => onChange({ default_par_level: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 1 })}
            className="input text-sm w-20"
            aria-label="Par level"
          />
        )}
      </div>
      {value.par_mode === 'smart' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <select
              value={value.smart_group ?? ''}
              onChange={(e) => onChange({ smart_group: e.target.value as ParSmartGroup })}
              className="input text-sm"
              aria-label="Smart group"
            >
              {Object.entries(PAR_SMART_GROUPS).map(([key, spec]) => (
                <option key={key} value={key}>{spec.label}</option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              step="any"
              value={value.base_qty}
              onChange={(e) => onChange({ base_qty: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 1 })}
              className="input text-sm w-20"
              aria-label="Base quantity"
              placeholder={value.smart_group ? MULTIPLIER_UNIT_LABEL[value.smart_group] : undefined}
            />
            <span className="text-xs text-muted-themed whitespace-nowrap">
              {value.smart_group ? MULTIPLIER_UNIT_LABEL[value.smart_group] : ''}
            </span>
          </div>
          {preview !== null && (
            <p className="text-xs text-muted-themed">
              Preview (2 ba / 3 br / 6 guests): <strong>{preview}</strong>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── CSV parsing ──────────────────────────────────────────────────────────────
// Same quoted-field splitting approach as vendors-client.tsx/crew-manage-
// client.tsx/create-template-builder.tsx's parseCSV — no new parsing
// dependency introduced here.

interface ParsedCatalogRow {
  name:              string
  categoryRaw:       string
  category:          InventoryCategory
  categoryInvalid:   boolean
  default_unit:      string
  default_par_level: number
  description:       string
}

function splitCatalogCSVLine(line: string): string[] {
  return (line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) ?? line.split(','))
    .map((c) => c.replace(/^"|"$/g, '').trim())
}

function normalizeCatalogCategory(raw: string): { category: InventoryCategory; invalid: boolean } {
  const match = CATEGORIES.find((c) => c === raw.toLowerCase().replaceAll(' ', '_'))
  return match ? { category: match, invalid: false } : { category: 'other', invalid: true }
}

function parseCatalogCSV(text: string): ParsedCatalogRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []

  const header = lines[0]!.toLowerCase()
  const looksLikeHeader = header.includes('name') && (header.includes('category') || header.includes('unit'))
  const dataLines = looksLikeHeader ? lines.slice(1) : lines

  const cols0 = looksLikeHeader ? splitCatalogCSVLine(lines[0]!) : []
  const nameIdx = looksLikeHeader ? cols0.findIndex((c) => c.toLowerCase() === 'name') : -1
  const catIdx  = looksLikeHeader ? cols0.findIndex((c) => c.toLowerCase() === 'category') : -1
  const unitIdx = looksLikeHeader ? cols0.findIndex((c) => c.toLowerCase() === 'unit') : -1
  const parIdx  = looksLikeHeader ? cols0.findIndex((c) => c.toLowerCase().replace(/\s/g, '') === 'parlevel') : -1
  const descIdx = looksLikeHeader ? cols0.findIndex((c) => c.toLowerCase() === 'description') : -1

  return dataLines
    .map((line) => {
      const cols = splitCatalogCSVLine(line)
      const name = nameIdx >= 0 ? (cols[nameIdx] ?? '') : (cols[0] ?? '')
      const categoryRaw = catIdx >= 0 ? (cols[catIdx] ?? '') : (cols[1] ?? '')
      const { category, invalid } = normalizeCatalogCategory(categoryRaw || 'other')
      const parRaw = parIdx >= 0 ? (cols[parIdx] ?? '') : (cols[3] ?? '')
      const parParsed = Number.parseFloat(parRaw)

      return {
        name,
        categoryRaw,
        category,
        categoryInvalid:   invalid,
        default_unit:      unitIdx >= 0 ? (cols[unitIdx] || 'units') : (cols[2] || 'units'),
        // Number.isFinite guard, not `|| 1` — an explicit "0" in the CSV is
        // a real par level of zero, not a falsy placeholder to fall back on.
        default_par_level: Number.isFinite(parParsed) ? parParsed : 1,
        description:       descIdx >= 0 ? (cols[descIdx] ?? '') : (cols[4] ?? ''),
      }
    })
    .filter((r) => r.name)
}

function toRowState(item: Omit<RowState, 'dirty'>): RowState {
  return { ...item, dirty: false }
}

function updateRowField(rows: RowState[], id: string, field: keyof RowState, value: unknown): RowState[] {
  return rows.map((r) => (r.id === id ? { ...r, [field]: value, dirty: true } : r))
}

function updateRowPatch(rows: RowState[], id: string, patch: Partial<RowState>): RowState[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r))
}

function matchesFilter(row: RowState, search: string, categoryFilter: string): boolean {
  if (categoryFilter !== 'all' && row.category !== categoryFilter) return false
  if (!search) return true
  return row.name.toLowerCase().includes(search.toLowerCase())
}

export function InventoryCatalogEditor({
  initialItems,
}: Readonly<{
  initialItems: Array<{ id: string; name: string; category: InventoryCategory; default_unit: string; default_par_level: number; par_mode: ParMode; smart_group: ParSmartGroup | null; base_qty: number; description: string; is_active: boolean }>
}>) {
  const [rows, setRows] = useState<RowState[]>(() => initialItems.map(toRowState))
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [saving, startSave] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedRowId, setSavedRowId] = useState<string | null>(null)

  const [newItem, setNewItem] = useState<CatalogItemInput>({
    name: '', category: 'other', default_unit: 'units', default_par_level: 1,
    par_mode: 'static', smart_group: null, base_qty: 1,
    description: '', is_active: true,
  })

  const [csvOpen, setCsvOpen] = useState(false)
  const [csvRows, setCsvRows] = useState<ParsedCatalogRow[]>([])
  const [csvImporting, startCsvImport] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const visibleRows = useMemo(
    () => rows.filter((r) => matchesFilter(r, search, categoryFilter)),
    [rows, search, categoryFilter]
  )

  function handleFieldChange(id: string, field: keyof RowState, value: unknown) {
    setRows((prev) => updateRowField(prev, id, field, value))
  }

  function handleParConfigChange(id: string, patch: Partial<ParConfigValue>) {
    setRows((prev) => updateRowPatch(prev, id, patch))
  }

  function handleSaveRow(row: RowState) {
    startSave(async () => {
      setError(null)
      const result = await updateCatalogItem(row.id, {
        name:              row.name,
        category:          row.category,
        default_unit:      row.default_unit,
        default_par_level: row.default_par_level,
        par_mode:          row.par_mode,
        smart_group:       row.smart_group,
        base_qty:          row.base_qty,
        description:       row.description,
        is_active:         row.is_active,
      })
      if (result.error) { setError(result.error); return }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, dirty: false } : r)))
      setSavedRowId(row.id)
      setTimeout(() => setSavedRowId(null), 2000)
    })
  }

  function handleDeleteRow(id: string) {
    startSave(async () => {
      setError(null)
      const result = await deleteCatalogItem(id)
      if (result.error) { setError(result.error); return }
      setRows((prev) => prev.filter((r) => r.id !== id))
    })
  }

  function handleCreate() {
    if (!newItem.name.trim()) return
    startSave(async () => {
      setError(null)
      const result = await createCatalogItem(newItem)
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to create item.')
        return
      }
      setRows((prev) => [...prev, toRowState({ id: result.id!, ...newItem })])
      setNewItem({
        name: '', category: 'other', default_unit: 'units', default_par_level: 1,
        par_mode: 'static', smart_group: null, base_qty: 1,
        description: '', is_active: true,
      })
    })
  }

  function handleCsvFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setError(null)
      setCsvRows(parseCatalogCSV(String(reader.result ?? '')))
    }
    reader.readAsText(file)
  }

  function handleCsvImport() {
    if (!csvRows.length) return
    startCsvImport(async () => {
      setError(null)
      const result = await bulkImportCatalogItems(
        csvRows.map((r) => ({
          name:              r.name,
          category:          r.category,
          default_unit:      r.default_unit,
          default_par_level: r.default_par_level,
          description:       r.description,
        }))
      )
      if (result.error || !result.items) { setError(result.error ?? 'Import failed.'); return }
      setRows((prev) => [...prev, ...result.items!.map(toRowState)])
      setCsvRows([])
      setCsvOpen(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    })
  }

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="input text-sm flex-1 min-w-[180px]"
          aria-label="Search catalog items"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="input text-sm"
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
        </select>
      </div>

      <div className="border border-themed rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-themed text-left">
              <th className="px-3 py-2 font-medium text-muted-themed">Name</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Category</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Unit</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Par Config</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Description</th>
              <th className="px-3 py-2 font-medium text-muted-themed">Active</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-themed">
            {visibleRows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">
                  <input
                    value={row.name}
                    onChange={(e) => handleFieldChange(row.id, 'name', e.target.value)}
                    className="input text-sm w-full"
                    aria-label="Item name"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={row.category}
                    onChange={(e) => handleFieldChange(row.id, 'category', e.target.value)}
                    className="input text-sm"
                    aria-label="Item category"
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.default_unit}
                    onChange={(e) => handleFieldChange(row.id, 'default_unit', e.target.value)}
                    className="input text-sm w-20"
                    aria-label="Default unit"
                  />
                </td>
                <td className="px-3 py-2">
                  <ParConfigFields
                    value={{ par_mode: row.par_mode, smart_group: row.smart_group, base_qty: row.base_qty, default_par_level: row.default_par_level }}
                    onChange={(patch) => handleParConfigChange(row.id, patch)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.description}
                    onChange={(e) => handleFieldChange(row.id, 'description', e.target.value)}
                    className="input text-sm w-full"
                    aria-label="Item description"
                  />
                </td>
                <td className="px-3 py-2">
                  <Checkbox
                    checked={row.is_active}
                    onChange={() => handleFieldChange(row.id, 'is_active', !row.is_active)}
                    aria-label="Item active"
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => handleSaveRow(row)}
                      disabled={saving || !row.dirty}
                      className="text-xs inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      {savedRowId === row.id ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeleteRow(row.id)}
                      disabled={saving}
                      className="p-1 text-muted-themed hover:text-red-500"
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-themed text-sm">
                  No items match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border border-themed rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Add New Item</h3>
        <div className="grid gap-2 sm:grid-cols-5">
          <input
            value={newItem.name}
            onChange={(e) => setNewItem((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Item name"
            className="input text-sm sm:col-span-2"
          />
          <select
            value={newItem.category}
            onChange={(e) => setNewItem((prev) => ({ ...prev, category: e.target.value as InventoryCategory }))}
            className="input text-sm"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{INVENTORY_CATEGORY_LABELS[c]}</option>)}
          </select>
          <input
            value={newItem.default_unit}
            onChange={(e) => setNewItem((prev) => ({ ...prev, default_unit: e.target.value }))}
            placeholder="Unit"
            className="input text-sm"
          />
          <input
            value={newItem.description}
            onChange={(e) => setNewItem((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Description (optional)"
            className="input text-sm"
          />
        </div>
        <div className="mt-2">
          <ParConfigFields
            value={{ par_mode: newItem.par_mode, smart_group: newItem.smart_group, base_qty: newItem.base_qty, default_par_level: newItem.default_par_level }}
            onChange={(patch) => setNewItem((prev) => ({ ...prev, ...patch }))}
          />
        </div>
        <Button
          variant="secondary"
          onClick={handleCreate}
          disabled={saving || !newItem.name.trim()}
          className="mt-3 inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Add Item
        </Button>
      </div>

      <div className="border border-themed rounded-xl p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Bulk Upload via CSV</h3>
          <Button
            variant="ghost"
            onClick={() => setCsvOpen((prev) => !prev)}
            className="text-xs inline-flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" /> {csvOpen ? 'Close' : 'Upload CSV'}
          </Button>
        </div>

        {csvOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-themed">
              Columns: name, category, unit, par_level, description. A header row is optional.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvFileChange}
              className="text-sm"
              aria-label="CSV file"
            />

            {csvRows.length > 0 && (
              <>
                <div className="border border-themed rounded-lg overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-themed text-left">
                        <th className="px-2 py-1.5 font-medium text-muted-themed">Name</th>
                        <th className="px-2 py-1.5 font-medium text-muted-themed">Category</th>
                        <th className="px-2 py-1.5 font-medium text-muted-themed">Unit</th>
                        <th className="px-2 py-1.5 font-medium text-muted-themed">Par Level</th>
                        <th className="px-2 py-1.5 font-medium text-muted-themed">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-themed">
                      {csvRows.map((r, i) => (
                        <tr key={`${r.name}-${i}`}>
                          <td className="px-2 py-1.5 flex items-center gap-1.5">
                            <FileText className="w-3 h-3 text-muted-themed shrink-0" />
                            {r.name}
                          </td>
                          <td className="px-2 py-1.5">
                            {r.categoryInvalid
                              ? <span style={{ color: 'var(--accent-red)' }}>{r.categoryRaw || 'other'} → other</span>
                              : INVENTORY_CATEGORY_LABELS[r.category]}
                          </td>
                          <td className="px-2 py-1.5">{r.default_unit}</td>
                          <td className="px-2 py-1.5">{r.default_par_level}</td>
                          <td className="px-2 py-1.5">{r.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button
                  variant="secondary"
                  onClick={handleCsvImport}
                  disabled={csvImporting}
                  className="inline-flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Import {csvRows.length} Item{csvRows.length === 1 ? '' : 's'}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
