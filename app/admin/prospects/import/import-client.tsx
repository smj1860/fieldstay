'use client'

import { useId, useMemo, useState, useTransition } from 'react'
import { Upload, Play, Undo2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { parseCsv } from '@/lib/prospecting/csv'
import {
  autoMapColumns,
  FIELD_LABELS,
  IMPORT_FIELDS,
  REQUIRED_FIELD,
  type ColumnIndex,
  type ImportField,
} from '@/lib/prospecting/columns'
import {
  buildPlan,
  dedupe,
  mapRows,
  type ImportPlan,
  type MappedRow,
  type ProspectUpsert,
} from '@/lib/prospecting/import'
import type { ProspectImport } from '@/types/database'
import { APPLY_CHUNK } from './constants'
import {
  applyImportChunk,
  finishProspectImport,
  loadProspectIdentityIndex,
  startProspectImport,
  undoProspectImport,
} from './actions'

/**
 * Read entirely in the browser, so these bound memory here rather than an
 * upload size. 20,000 rows is well past the largest list this funnel has
 * ever seen (3,400) and still parses in well under a second.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 20_000

/** How many warnings to render before collapsing to a count. */
const WARNINGS_SHOWN = 25

const SELECT_CLASS = 'input text-xs py-1'

interface ParsedFile {
  name:    string
  header:  string[]
  grid:    string[][]
  mapping: ColumnIndex
}

interface RunResult {
  created: number
  updated: number
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function ProspectImportClient({
  initialImports,
}: Readonly<{ initialImports: ProspectImport[] }>) {
  const [file, setFile]       = useState<ParsedFile | null>(null)
  const [plan, setPlan]       = useState<ImportPlan | null>(null)
  const [result, setResult]   = useState<RunResult | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError]     = useState('')
  const [imports, setImports] = useState(initialImports)
  const [pending, startTransition] = useTransition()
  const fileInputId = useId()

  /** Re-derived whenever the mapping changes, so the preview tracks edits. */
  const mapped: MappedRow[] = useMemo(
    () => (file === null ? [] : mapRows(file.grid, file.mapping)),
    [file],
  )

  const rows: ProspectUpsert[] = useMemo(() => {
    const usable = mapped
      .map((m) => m.upsert)
      .filter((r): r is ProspectUpsert => r !== null)
    return dedupe(usable).rows
  }, [mapped])

  const warnings = useMemo(
    () => mapped.flatMap((m) => m.warnings.map((w) => ({ line: m.line, text: w }))),
    [mapped],
  )

  const skipped = mapped.filter((m) => m.upsert === null).length
  const mappedOk = file !== null && file.mapping[REQUIRED_FIELD] !== undefined

  function reset(): void {
    setPlan(null)
    setResult(null)
    setProgress(0)
  }

  async function onPickFile(picked: File | undefined): Promise<void> {
    setError('')
    reset()
    setFile(null)
    if (picked === undefined) return

    if (picked.size > MAX_FILE_BYTES) {
      setError(`${picked.name} is larger than 10 MB. Split it and import the parts.`)
      return
    }

    const grid = parseCsv(await picked.text())
    if (grid.length < 2) {
      setError(`${picked.name} has a header but no data rows.`)
      return
    }
    if (grid.length - 1 > MAX_ROWS) {
      setError(`${picked.name} has more than ${MAX_ROWS.toLocaleString()} rows. Split it and import the parts.`)
      return
    }

    const header = grid[0]
    setFile({ name: picked.name, header, grid: grid.slice(1), mapping: autoMapColumns(header) })
  }

  function setMapping(field: ImportField, at: number | undefined): void {
    reset()
    setFile((f) => (f === null ? null : { ...f, mapping: { ...f.mapping, [field]: at } }))
  }

  function checkAgainstDatabase(): void {
    setError('')
    startTransition(async () => {
      const res = await loadProspectIdentityIndex()
      if (res.rows === undefined) {
        setError(res.error ?? 'Could not load the existing account list.')
        return
      }
      setPlan(buildPlan(rows, res.rows))
    })
  }

  function runImport(): void {
    if (plan === null || file === null) return
    setError('')
    setProgress(0)
    startTransition(async () => {
      const started = await startProspectImport(file.name, rows.length, skipped)
      const importId = started.id
      if (importId === undefined) {
        setError(started.error ?? 'Could not start the import.')
        return
      }

      const outcome = await applyPlan(importId, plan, setProgress)
      if (outcome.error !== undefined) {
        await finishProspectImport(importId, outcome.counts, outcome.error)
        setError(outcome.error)
        setResult(outcome.counts)
        return
      }

      await finishProspectImport(importId, outcome.counts)
      setResult(outcome.counts)
      setPlan(null)
      const refreshed = await listRefresh()
      if (refreshed !== null) setImports(refreshed)
    })
  }

  function undo(id: string): void {
    setError('')
    startTransition(async () => {
      const res = await undoProspectImport(id)
      if (res.deleted === undefined) {
        setError(res.error ?? 'Could not undo that import.')
        return
      }
      const refreshed = await listRefresh()
      if (refreshed !== null) setImports(refreshed)
    })
  }

  const total = plan === null ? 0 : plan.updates.length + plan.inserts.length

  return (
    <div className="space-y-6">
      {error !== '' && <InlineAlert tone="error">{error}</InlineAlert>}

      {result !== null && (
        <InlineAlert tone="success">
          Imported {file?.name}: {plural(result.created, 'account added', 'accounts added')},{' '}
          {plural(result.updated, 'updated', 'updated')}.
        </InlineAlert>
      )}

      <FilePicker
        inputId={fileInputId}
        fileName={file?.name ?? null}
        disabled={pending}
        onPick={onPickFile}
      />

      {file !== null && (
        <MappingTable
          header={file.header}
          mapping={file.mapping}
          disabled={pending}
          onChange={setMapping}
        />
      )}

      {file !== null && !mappedOk && (
        <InlineAlert tone="warning">
          Map a column to <strong>{FIELD_LABELS[REQUIRED_FIELD]}</strong> before importing —
          it is the only field a row cannot be written without.
        </InlineAlert>
      )}

      {file !== null && mappedOk && (
        <>
          <PreviewSummary
            fileRows={file.grid.length}
            unique={rows.length}
            skipped={skipped}
            warnings={warnings.length}
          />
          <WarningList warnings={warnings} />
          <Preview rows={rows} />

          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={checkAgainstDatabase} disabled={pending}>
              Check against the database
            </Button>
            {plan !== null && (
              <Button
                variant="primary"
                onClick={runImport}
                disabled={pending || total === 0}
                className="flex items-center gap-1"
              >
                <Play size={14} aria-hidden="true" /> Import {plural(total, 'row', 'rows')}
              </Button>
            )}
          </div>
        </>
      )}

      {plan !== null && <PlanSummary plan={plan} />}

      {pending && progress > 0 && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Writing… {progress.toLocaleString()} of {total.toLocaleString()}
        </p>
      )}

      <ImportHistory imports={imports} disabled={pending} onUndo={undo} />
    </div>
  )
}

/**
 * Applies the plan in chunks, reporting progress as it goes.
 *
 * Stops at the first failed chunk rather than pressing on: the chunks are
 * ordered, and continuing past a failure would leave a partial import whose
 * counts say it succeeded.
 */
async function applyPlan(
  importId: string,
  plan: ImportPlan,
  onProgress: (n: number) => void,
): Promise<{ counts: RunResult; error?: string }> {
  const counts: RunResult = { created: 0, updated: 0 }
  let done = 0

  const batches: { updates: ImportPlan['updates']; inserts: Record<string, unknown>[] }[] = []
  for (let at = 0; at < plan.updates.length; at += APPLY_CHUNK) {
    batches.push({ updates: plan.updates.slice(at, at + APPLY_CHUNK), inserts: [] })
  }
  for (let at = 0; at < plan.inserts.length; at += APPLY_CHUNK) {
    batches.push({
      updates: [],
      inserts: plan.inserts.slice(at, at + APPLY_CHUNK).map((r) => ({ ...r })),
    })
  }

  for (const batch of batches) {
    const res = await applyImportChunk(importId, batch)
    if (res.error !== undefined) return { counts, error: res.error }
    counts.created += res.created ?? 0
    counts.updated += res.updated ?? 0
    done += batch.updates.length + batch.inserts.length
    onProgress(done)
  }

  return { counts }
}

async function listRefresh(): Promise<ProspectImport[] | null> {
  const { listProspectImports } = await import('./actions')
  const res = await listProspectImports()
  return res.imports ?? null
}

function FilePicker({
  inputId, fileName, disabled, onPick,
}: Readonly<{
  inputId:  string
  fileName: string | null
  disabled: boolean
  onPick:   (file: File | undefined) => void
}>) {
  return (
    <div>
      <label
        htmlFor={inputId}
        className="block text-sm font-medium mb-1"
        style={{ color: 'var(--text-primary)' }}
      >
        CSV file
      </label>
      <div className="flex items-center gap-3">
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          disabled={disabled}
          className="text-sm"
          style={{ color: 'var(--text-secondary)' }}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        {fileName !== null && (
          <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            <Upload size={12} aria-hidden="true" /> {fileName}
          </span>
        )}
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        One file per run, so each import gets its own history row and its own undo.
        For a Google Sheet use File → Download → CSV.
      </p>
    </div>
  )
}

function MappingTable({
  header, mapping, disabled, onChange,
}: Readonly<{
  header:   string[]
  mapping:  ColumnIndex
  disabled: boolean
  onChange: (field: ImportField, at: number | undefined) => void
}>) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
        Columns
      </h3>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        Matched by exact header name. A field left unmapped is simply not written —
        it never clears what the account already has.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {IMPORT_FIELDS.map((field) => (
          <div key={field} className="flex items-center justify-between gap-2">
            <label
              htmlFor={`map-${field}`}
              className="text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              {FIELD_LABELS[field]}
              {field === REQUIRED_FIELD && (
                <span style={{ color: 'var(--accent-red)' }} aria-hidden="true"> *</span>
              )}
            </label>
            <select
              id={`map-${field}`}
              className={SELECT_CLASS}
              disabled={disabled}
              value={mapping[field] ?? ''}
              onChange={(e) => onChange(field, e.target.value === '' ? undefined : Number(e.target.value))}
            >
              <option value="">— not in this file —</option>
              {header.map((name, at) => (
                <option key={`${name}-${at}`} value={at}>{name || `(column ${at + 1})`}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

function PreviewSummary({
  fileRows, unique, skipped, warnings,
}: Readonly<{ fileRows: number; unique: number; skipped: number; warnings: number }>) {
  return (
    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
      <strong style={{ color: 'var(--text-primary)' }}>{fileRows.toLocaleString()}</strong> rows in the file
      {' · '}{unique.toLocaleString()} unique companies after dedupe
      {skipped > 0 && <> · {skipped.toLocaleString()} skipped (no company name)</>}
      {warnings > 0 && <> · {warnings.toLocaleString()} warnings</>}
    </p>
  )
}

function WarningList({
  warnings,
}: Readonly<{ warnings: { line: number; text: string }[] }>) {
  if (warnings.length === 0) return null
  return (
    <details>
      <summary
        className="text-xs cursor-pointer flex items-center gap-1"
        style={{ color: 'var(--accent-amber)' }}
      >
        <AlertTriangle size={12} aria-hidden="true" />
        {warnings.length.toLocaleString()} cell(s) could not be used
      </summary>
      <ul className="mt-2 space-y-1">
        {warnings.slice(0, WARNINGS_SHOWN).map((w) => (
          <li key={`${w.line}-${w.text}`} className="text-xs" style={{ color: 'var(--text-muted)' }}>
            line {w.line}: {w.text}
          </li>
        ))}
        {warnings.length > WARNINGS_SHOWN && (
          <li className="text-xs" style={{ color: 'var(--text-muted)' }}>
            … and {(warnings.length - WARNINGS_SHOWN).toLocaleString()} more
          </li>
        )}
      </ul>
    </details>
  )
}

const PREVIEW_ROWS = 10

function Preview({ rows }: Readonly<{ rows: ProspectUpsert[] }>) {
  if (rows.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr
            className="border-b text-left uppercase tracking-wide"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
          >
            <th scope="col" className="py-2 pr-3">Company</th>
            <th scope="col" className="py-2 pr-3">Where</th>
            <th scope="col" className="py-2 pr-3">Domain</th>
            <th scope="col" className="py-2 pr-3">PMS</th>
            <th scope="col" className="py-2 pr-3 text-right">Doors</th>
            <th scope="col" className="py-2 pr-3">Contact</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, PREVIEW_ROWS).map((r) => (
            <tr key={`${r.company}-${r.city ?? ''}-${r.state ?? ''}`} className="border-b"
                style={{ borderColor: 'var(--border)' }}>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-primary)' }}>{r.company}</td>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>
                {[r.city, r.state].filter(Boolean).join(', ') || '—'}
              </td>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>{r.domain ?? '—'}</td>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>{r.pms ?? '—'}</td>
              <td className="py-1.5 pr-3 text-right" style={{ color: 'var(--text-muted)' }}>
                {r.portfolio_size ?? '—'}
              </td>
              <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>
                {r.email ?? r.contact_name ?? r.phone ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PREVIEW_ROWS && (
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Showing the first {PREVIEW_ROWS} of {rows.length.toLocaleString()}.
        </p>
      )}
    </div>
  )
}

function PlanSummary({ plan }: Readonly<{ plan: ImportPlan }>) {
  const fields = Object.entries(plan.fieldCounts).sort((a, b) => b[1] - a[1])
  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
    >
      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
        Would add <strong>{plan.inserts.length.toLocaleString()}</strong> new accounts
        and update <strong>{plan.updates.length.toLocaleString()}</strong>.
        {plan.untouched > 0 && (
          <> {plan.untouched.toLocaleString()} already match and would not change.</>
        )}
      </p>
      {plan.droppedDomains > 0 && (
        <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>
          {plan.droppedDomains.toLocaleString()} row(s) will be written without their domain —
          another account already claims it.
        </p>
      )}
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        An <em>add</em> count close to the file&apos;s row count means the match key is not
        finding accounts it should. Stop and look before importing.
      </p>
      {fields.length > 0 && (
        <details>
          <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            Columns that would be written
          </summary>
          <ul className="mt-1 grid gap-0.5 sm:grid-cols-3">
            {fields.map(([col, n]) => (
              <li key={col} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {col} — {n.toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function ImportHistory({
  imports, disabled, onUndo,
}: Readonly<{ imports: ProspectImport[]; disabled: boolean; onUndo: (id: string) => void }>) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
        Recent imports
      </h3>
      {imports.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No imports yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr
                className="border-b text-left uppercase tracking-wide"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                <th scope="col" className="py-2 pr-3">File</th>
                <th scope="col" className="py-2 pr-3">When</th>
                <th scope="col" className="py-2 pr-3 text-right">Added</th>
                <th scope="col" className="py-2 pr-3 text-right">Updated</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2 pr-3"><span className="sr-only">Undo</span></th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-1.5 pr-3" style={{ color: 'var(--text-primary)' }}>{imp.source_name}</td>
                  <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>
                    {new Date(imp.created_at).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3 text-right" style={{ color: 'var(--text-muted)' }}>
                    {imp.created_count.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3 text-right" style={{ color: 'var(--text-muted)' }}>
                    {imp.updated_count.toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>{imp.status}</td>
                  <td className="py-1.5 pr-3">
                    {imp.status === 'complete' && imp.created_count > 0 && (
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        className="text-xs flex items-center gap-1"
                        onClick={() => onUndo(imp.id)}
                      >
                        <Undo2 size={12} aria-hidden="true" /> Undo
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Undo removes only the accounts an import added that nobody has worked since.
            Fields it filled on accounts that already existed stay.
          </p>
        </div>
      )}
    </div>
  )
}
