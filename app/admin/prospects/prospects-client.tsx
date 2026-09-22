'use client'

import { useEffect, useId, useMemo, useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, Download, Plus, Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { patchById } from '@/lib/utils'
import { toCsv } from '@/lib/prospecting/csv'
import {
  updateProspect, createProspect, bulkSetStatus,
  logProspectTouch, listProspectTouches, triggerProspectCrawl,
} from './actions'
import {
  PROSPECT_STATUSES,
  PROSPECT_STATUS_LABELS,
  CLOSED_STATUSES,
  TOUCH_TYPES,
  TOUCH_TYPE_LABELS,
  type ProspectRow,
  type ProspectStatus,
  type ProspectEditableFields,
  type ProspectTouch,
  type TouchType,
} from './constants'

/**
 * Which contact channel an account is reachable on — the filter this list
 * gets used through most. "Who can I actually email on Monday" and "which
 * role inboxes still need a real name behind them" are different work, and
 * both are invisible if you can only filter on status.
 */
type ContactFilter =
  | 'any' | 'named_email' | 'generic_email' | 'no_email' | 'phone_only' | 'no_contact'

const CONTACT_FILTER_LABELS: Record<ContactFilter, string> = {
  any:           'Any contact',
  named_email:   'Named email',
  generic_email: 'Role inbox (info@ …)',
  no_email:      'No email',
  phone_only:    'Phone only',
  no_contact:    'No contact at all',
}

const CONTACT_FILTERS = Object.keys(CONTACT_FILTER_LABELS) as ContactFilter[]

function matchesContactFilter(r: ProspectRow, f: ContactFilter): boolean {
  const hasEmail = !!r.email?.trim()
  const hasPhone = !!r.phone?.trim()
  switch (f) {
    case 'named_email':   return hasEmail && !r.email_is_generic
    case 'generic_email': return hasEmail && !!r.email_is_generic
    case 'no_email':      return !hasEmail
    case 'phone_only':    return !hasEmail && hasPhone
    case 'no_contact':    return !hasEmail && !hasPhone
    default:              return true
  }
}

interface Facets {
  state:   string
  market:  string
  pms:     string
  track:   string
  status:  string
  contact: ContactFilter
  closed:  boolean
}

const EMPTY_FACETS: Facets = {
  state: '', market: '', pms: '', track: '', status: '', contact: 'any', closed: false,
}

function matchesFacets(r: ProspectRow, f: Facets): boolean {
  if (!f.closed && CLOSED_STATUSES.includes(r.status)) return false
  if (f.state  && r.state  !== f.state)  return false
  if (f.market && r.market !== f.market) return false
  if (f.pms    && r.pms    !== f.pms)    return false
  if (f.track  && r.track  !== f.track)  return false
  if (f.status && r.status !== f.status) return false
  return matchesContactFilter(r, f.contact)
}

function matchesSearch(r: ProspectRow, q: string): boolean {
  if (!q) return true
  const haystack = [
    r.company, r.city, r.market, r.pms, r.contact_name,
    r.domain, r.email, r.phone, r.notes, r.pms_note,
  ]
  return haystack.some((v) => v?.toLowerCase().includes(q))
}

function uniqueSorted(values: (string | null)[]): string[] {
  return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))]
    .sort((a, b) => a.localeCompare(b))
}

const EXPORT_COLUMNS: (keyof ProspectRow)[] = [
  'company', 'city', 'state', 'market', 'portfolio_size', 'pms',
  'contact_name', 'contact_title', 'email', 'phone', 'linkedin_url',
  'domain', 'score_a', 'score_b', 'track', 'bucket', 'status',
  'next_action_at', 'last_touch_at', 'pms_note', 'notes',
]

function daysSince(iso: string | null): number | null {
  if (iso === null) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null
}

/** The "Last crawled" line under an expanded row's edit fields. */
function crawlStatusLine(row: ProspectRow): string {
  if (row.comparent_url === null) {
    return 'No comparent_url on file — not eligible for "Refresh from Comparent."'
  }
  if (row.last_crawled_at === null) return 'Never crawled.'

  const days = daysSince(row.last_crawled_at)
  const when = days === 0 ? 'today' : `${days}d ago`

  let suffix = ''
  if (row.crawl_status === 'error') suffix = ' — last attempt failed'
  else if (row.crawl_status === 'no_website') suffix = ' — no website found'

  return `Last crawled ${when}${suffix}`
}

function blankRow(id: string, company: string): ProspectRow {
  return {
    id, company, domain: null, website: null, city: null, state: null,
    market: null, portfolio_size: null, pms: null, pms_note: null,
    score_a: null, score_b: null, track: null, bucket: null,
    contact_name: null, contact_title: null, email: null, email_is_generic: false,
    phone: null, linkedin_url: null, status: 'new', status_note: null,
    notes: null, last_touch_at: null, next_action_at: null,
    comparent_url: null, last_crawled_at: null, crawl_status: null,
  }
}

function applyStatusTo(
  rows: ProspectRow[],
  ids: ReadonlySet<string>,
  status: ProspectStatus,
): ProspectRow[] {
  return rows.map((r) => (ids.has(r.id) ? { ...r, status } : r))
}

function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

const SELECT_CLASS = 'input text-xs py-1'

export function ProspectsClient({ initialRows }: Readonly<{ initialRows: ProspectRow[] }>) {
  const [rows, setRows]         = useState<ProspectRow[]>(initialRows)
  const [search, setSearch]     = useState('')
  const [facets, setFacets]     = useState<Facets>(EMPTY_FACETS)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [error, setError]       = useState('')
  const [savedId, setSavedId]   = useState('')
  const [newCompany, setNewCompany] = useState('')
  const [crawlMessage, setCrawlMessage] = useState('')
  const [pending, startTransition] = useTransition()

  const states  = useMemo(() => uniqueSorted(rows.map((r) => r.state)),  [rows])
  const markets = useMemo(() => uniqueSorted(rows.map((r) => r.market)), [rows])
  const pmsList = useMemo(() => uniqueSorted(rows.map((r) => r.pms)),    [rows])
  const tracks  = useMemo(() => uniqueSorted(rows.map((r) => r.track)),  [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => matchesFacets(r, facets) && matchesSearch(r, q))
  }, [rows, search, facets])

  const doors = useMemo(
    () => filtered.reduce((sum, r) => sum + (r.portfolio_size ?? 0), 0),
    [filtered],
  )

  function setFacet<K extends keyof Facets>(key: K, value: Facets[K]) {
    setFacets((f) => ({ ...f, [key]: value }))
  }

  function save(id: string, patch: Partial<ProspectEditableFields>) {
    // Optimistic: the row updates immediately and reverts only if the server
    // rejects it. A cell that waits for a round trip is unusable when you are
    // working down a list of forty.
    const before = rows.find((r) => r.id === id)
    setRows(patchById<ProspectRow>(id, patch))
    setError('')
    startTransition(async () => {
      const res = await updateProspect(id, patch)
      if (res.error !== undefined) {
        setError(res.error)
        if (before !== undefined) setRows(patchById<ProspectRow>(id, before))
        return
      }
      setSavedId(id)
    })
  }

  function applyBulkStatus(status: ProspectStatus) {
    const ids = [...selected]
    if (ids.length === 0) return
    setError('')
    startTransition(async () => {
      const res = await bulkSetStatus(ids, status)
      if (res.error !== undefined) { setError(res.error); return }
      setRows((rs) => applyStatusTo(rs, selected, status))
      setSelected(new Set())
    })
  }

  function addProspect() {
    const company = newCompany.trim()
    if (!company) return
    setError('')
    startTransition(async () => {
      const res = await createProspect({ company })
      const id = res.id
      if (id === undefined) { setError(res.error ?? 'Could not add.'); return }
      setRows((rs) => [blankRow(id, company), ...rs])
      setNewCompany('')
      setExpanded((s) => toggle(s, id))
    })
  }

  function refreshFromComparent() {
    setError('')
    setCrawlMessage('')
    startTransition(async () => {
      const candidateCount = rows.filter((r) => r.comparent_url !== null).length
      const res = await triggerProspectCrawl()
      if (res.error !== undefined) { setError(res.error); return }
      setCrawlMessage(
        candidateCount === 0
          ? 'Queued — no accounts have a saved comparent_url yet, so there is nothing to refresh.'
          : 'Queued. Refreshed accounts will show an updated "Last crawled" time as the batch completes — reload the page in a few minutes to see it.',
      )
    })
  }

  function exportCsv() {
    // toCsv quotes what needs quoting AND defuses a leading =, +, - or @ —
    // a company literally named "=SUM(1)" would otherwise be evaluated as a
    // formula when this file is opened in Sheets or Excel.
    const csv  = toCsv(EXPORT_COLUMNS, filtered.map((r) => EXPORT_COLUMNS.map((c) => r[c])))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url    = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `prospects-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      {error !== '' && <InlineAlert tone="error">{error}</InlineAlert>}
      {crawlMessage !== '' && <InlineAlert tone="info">{crawlMessage}</InlineAlert>}

      <FilterBar
        search={search}
        onSearch={setSearch}
        facets={facets}
        onFacet={setFacet}
        states={states}
        markets={markets}
        pmsList={pmsList}
        tracks={tracks}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{filtered.length}</strong>
          {' '}of {rows.length} accounts
          {doors > 0 && <> · {doors.toLocaleString()} doors</>}
          {selected.size > 0 && <> · {selected.size} selected</>}
        </p>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <select
              className={SELECT_CLASS}
              aria-label={`Set status on ${selected.size} selected accounts`}
              value=""
              disabled={pending}
              onChange={(e) => {
                if (e.target.value !== '') applyBulkStatus(e.target.value as ProspectStatus)
              }}
            >
              <option value="">Set {selected.size} to…</option>
              {PROSPECT_STATUSES.map((s) => (
                <option key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          )}
          <Button
            variant="secondary"
            onClick={refreshFromComparent}
            disabled={pending}
            className="text-xs flex items-center gap-1"
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh from Comparent
          </Button>
          <Button
            variant="secondary"
            onClick={exportCsv}
            className="text-xs flex items-center gap-1"
          >
            <Download size={14} aria-hidden="true" /> Export view
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={newCompany}
          aria-label="New company name"
          onChange={(e) => setNewCompany(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addProspect() }}
          placeholder="Add a company you found…"
          className="max-w-xs text-sm"
        />
        <Button
          variant="secondary"
          onClick={addProspect}
          disabled={pending || newCompany.trim() === ''}
          className="text-xs flex items-center gap-1"
        >
          <Plus size={14} aria-hidden="true" /> Add
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b text-left text-xs uppercase tracking-wide"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              <th scope="col" className="py-2 w-8"><span className="sr-only">Select</span></th>
              <th scope="col" className="py-2 w-8"><span className="sr-only">Expand</span></th>
              <th scope="col" className="py-2 pr-3">Company</th>
              <th scope="col" className="py-2 pr-3">Where</th>
              <th scope="col" className="py-2 pr-3 text-right">Doors</th>
              <th scope="col" className="py-2 pr-3">PMS</th>
              <th scope="col" className="py-2 pr-3">Contact</th>
              <th scope="col" className="py-2 pr-3 text-right">A / B</th>
              <th scope="col" className="py-2 pr-3">Status</th>
              <th scope="col" className="py-2 pr-3">Next action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <ProspectRowView
                key={r.id}
                row={r}
                isOpen={expanded.has(r.id)}
                isSelected={selected.has(r.id)}
                justSaved={savedId === r.id}
                disabled={pending}
                onToggleOpen={() => setExpanded((s) => toggle(s, r.id))}
                onToggleSelect={() => setSelected((s) => toggle(s, r.id))}
                onSave={(patch) => save(r.id, patch)}
              />
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No accounts match these filters.
          </p>
        )}
      </div>
    </div>
  )
}

function FilterBar({
  search, onSearch, facets, onFacet, states, markets, pmsList, tracks,
}: Readonly<{
  search:   string
  onSearch: (v: string) => void
  facets:   Facets
  onFacet:  <K extends keyof Facets>(key: K, value: Facets[K]) => void
  states:   string[]
  markets:  string[]
  pmsList:  string[]
  tracks:   string[]
}>) {
  const closedId = useId()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={search}
        aria-label="Search accounts"
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search company, city, PMS, contact, email…"
        className="flex-1 min-w-[16rem]"
      />
      <FacetSelect
        label="State" value={facets.state} options={states}
        onChange={(v) => onFacet('state', v)} allLabel="All states"
      />
      <FacetSelect
        label="Market" value={facets.market} options={markets}
        onChange={(v) => onFacet('market', v)} allLabel="All markets"
      />
      <FacetSelect
        label="PMS" value={facets.pms} options={pmsList}
        onChange={(v) => onFacet('pms', v)} allLabel="All PMS"
      />
      <FacetSelect
        label="Track" value={facets.track} options={tracks}
        onChange={(v) => onFacet('track', v)} allLabel="All tracks"
      />
      <select
        className={SELECT_CLASS}
        aria-label="Filter by status"
        value={facets.status}
        onChange={(e) => onFacet('status', e.target.value)}
      >
        <option value="">All statuses</option>
        {PROSPECT_STATUSES.map((s) => (
          <option key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</option>
        ))}
      </select>
      <select
        className={SELECT_CLASS}
        aria-label="Filter by contact channel"
        value={facets.contact}
        onChange={(e) => onFacet('contact', e.target.value as ContactFilter)}
      >
        {CONTACT_FILTERS.map((f) => (
          <option key={f} value={f}>{CONTACT_FILTER_LABELS[f]}</option>
        ))}
      </select>
      <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        <input
          id={closedId}
          type="checkbox"
          checked={facets.closed}
          onChange={(e) => onFacet('closed', e.target.checked)}
        />
        <label htmlFor={closedId}>Show closed</label>
      </span>
    </div>
  )
}

function FacetSelect({
  label, value, options, onChange, allLabel,
}: Readonly<{
  label:    string
  value:    string
  options:  string[]
  onChange: (v: string) => void
  allLabel: string
}>) {
  return (
    <select
      className={SELECT_CLASS}
      aria-label={`Filter by ${label.toLowerCase()}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function ProspectRowView({
  row, isOpen, isSelected, justSaved, disabled, onToggleOpen, onToggleSelect, onSave,
}: Readonly<{
  row:            ProspectRow
  isOpen:         boolean
  isSelected:     boolean
  justSaved:      boolean
  disabled:       boolean
  onToggleOpen:   () => void
  onToggleSelect: () => void
  onSave:         (patch: Partial<ProspectEditableFields>) => void
}>) {
  const stale = daysSince(row.last_touch_at)

  return (
    <>
      <tr className="border-b align-top" style={{ borderColor: 'var(--border)' }}>
        <td className="py-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            aria-label={`Select ${row.company}`}
          />
        </td>
        <td className="py-2">
          <button
            type="button"
            onClick={onToggleOpen}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${row.company}`}
            style={{ color: 'var(--text-muted)' }}
          >
            {isOpen
              ? <ChevronDown size={14} aria-hidden="true" />
              : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        </td>
        <td className="py-2 pr-3">
          <span style={{ color: 'var(--text-primary)' }}>{row.company}</span>
          {justSaved && (
            <Check
              size={12}
              className="inline ml-1"
              style={{ color: 'var(--accent-gold)' }}
              aria-label="Saved"
            />
          )}
          {row.domain !== null && (
            <a
              href={row.website ?? `https://${row.domain}`}
              target="_blank"
              rel="noreferrer"
              className="block text-xs hover:underline"
              style={{ color: 'var(--text-muted)' }}
            >
              {row.domain}
            </a>
          )}
        </td>
        <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {[row.city, row.state].filter(Boolean).join(', ') || '—'}
        </td>
        <td className="py-2 pr-3 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
          {row.portfolio_size ?? '—'}
        </td>
        <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {row.pms ?? '—'}
        </td>
        <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <ContactCell row={row} />
        </td>
        <td className="py-2 pr-3 text-right text-xs" style={{ color: 'var(--text-muted)' }}>
          {row.score_a ?? '–'} / {row.score_b ?? '–'}
        </td>
        <td className="py-2 pr-3">
          <select
            className={SELECT_CLASS}
            aria-label={`Status for ${row.company}`}
            value={row.status}
            disabled={disabled}
            onChange={(e) => onSave({ status: e.target.value as ProspectStatus })}
          >
            {PROSPECT_STATUSES.map((s) => (
              <option key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</option>
            ))}
          </select>
          {stale !== null && (
            <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {stale === 0 ? 'touched today' : `${stale}d since touch`}
            </span>
          )}
        </td>
        <td className="py-2 pr-3">
          <input
            type="date"
            className="input text-xs py-1"
            aria-label={`Next action date for ${row.company}`}
            value={row.next_action_at ?? ''}
            disabled={disabled}
            onChange={(e) => onSave({ next_action_at: e.target.value })}
          />
        </td>
      </tr>

      {isOpen && (
        <tr style={{ borderColor: 'var(--border)' }}>
          <td colSpan={10} className="pb-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pl-12 pr-2">
              <Field label="Contact name" value={row.contact_name}
                     onSave={(v) => onSave({ contact_name: v })} />
              <Field label="Title" value={row.contact_title}
                     onSave={(v) => onSave({ contact_title: v })} />
              <Field label="Email" value={row.email}
                     onSave={(v) => onSave({ email: v })} />
              <Field label="Phone" value={row.phone}
                     onSave={(v) => onSave({ phone: v })} />
              <Field label="LinkedIn" value={row.linkedin_url}
                     onSave={(v) => onSave({ linkedin_url: v })} />
              <Field label="Domain" value={row.domain}
                     onSave={(v) => onSave({ domain: v })} />
              <Field label="PMS" value={row.pms}
                     onSave={(v) => onSave({ pms: v })} />
              <Field label="City" value={row.city}
                     onSave={(v) => onSave({ city: v })} />
              <Field label="Market" value={row.market}
                     onSave={(v) => onSave({ market: v })} />
              <Field label="How the PMS was identified" value={row.pms_note} textarea
                     onSave={(v) => onSave({ pms_note: v })} className="sm:col-span-2" />
              <Field label="Notes" value={row.notes} textarea
                     onSave={(v) => onSave({ notes: v })} className="sm:col-span-2" />
            </div>
            <p className="pl-12 pr-2 mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {crawlStatusLine(row)}
            </p>
            <HistoryPanel prospectId={row.id} />
          </td>
        </tr>
      )}
    </>
  )
}

function HistoryList({ touches }: Readonly<{ touches: ProspectTouch[] | null }>) {
  if (touches === null) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</p>
  }
  if (touches.length === 0) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No touches logged yet.</p>
  }
  return (
    <ul className="space-y-1 mb-2">
      {touches.map((t) => (
        <li key={t.id} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-primary)' }}>{TOUCH_TYPE_LABELS[t.touch_type]}</span>
          {' · '}
          {new Date(t.occurred_at).toLocaleDateString()}
          {t.note !== null && t.note !== '' && <> — {t.note}</>}
        </li>
      ))}
    </ul>
  )
}

/** Lazily loads and renders one prospect's touch history, plus a form to log a new one. */
function HistoryPanel({ prospectId }: Readonly<{ prospectId: string }>) {
  const [touches, setTouches] = useState<ProspectTouch[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [touchType, setTouchType] = useState<TouchType>('note')
  const [note, setNote] = useState('')
  const [logging, startLogging] = useTransition()

  useEffect(() => {
    let cancelled = false
    listProspectTouches(prospectId).then((res) => {
      if (cancelled) return
      if (res.error !== undefined) { setLoadError(res.error); return }
      setTouches(res.touches ?? [])
    })
    return () => { cancelled = true }
  }, [prospectId])

  function logTouch() {
    startLogging(async () => {
      const res = await logProspectTouch(prospectId, touchType, note.trim() || undefined)
      if (res.error !== undefined) { setLoadError(res.error); return }
      setNote('')
      const refreshed = await listProspectTouches(prospectId)
      if (refreshed.touches !== undefined) setTouches(refreshed.touches)
    })
  }

  return (
    <div className="pl-12 pr-2 mt-3">
      <p className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
        History
      </p>

      {loadError !== '' && <InlineAlert tone="error" className="mb-2">{loadError}</InlineAlert>}

      <HistoryList touches={touches} />

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT_CLASS}
          aria-label="Touch type"
          value={touchType}
          disabled={logging}
          onChange={(e) => setTouchType(e.target.value as TouchType)}
        >
          {TOUCH_TYPES.map((t) => (
            <option key={t} value={t}>{TOUCH_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <Input
          value={note}
          aria-label="Touch note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') logTouch() }}
          placeholder="Optional note…"
          className="max-w-xs text-xs"
        />
        <Button
          variant="secondary"
          onClick={logTouch}
          disabled={logging}
          className="text-xs"
        >
          Log
        </Button>
      </div>
    </div>
  )
}

function ContactCell({ row }: Readonly<{ row: ProspectRow }>) {
  const nothing = row.contact_name === null && row.email === null && row.phone === null
  if (nothing) return <>—</>
  return (
    <>
      {row.contact_name !== null && <span className="block">{row.contact_name}</span>}
      {row.email !== null && (
        <span className={`block ${row.email_is_generic === true ? 'opacity-60' : ''}`}>
          {row.email}{row.email_is_generic === true && ' (role)'}
        </span>
      )}
      {row.phone !== null && <span className="block">{row.phone}</span>}
    </>
  )
}

/**
 * Saves on blur rather than on every keystroke: a server action per character
 * would be one write per letter of "Tiffany Rainwater".
 */
function Field({
  label, value, onSave, textarea = false, className = '',
}: Readonly<{
  label:     string
  value:     string | null
  onSave:    (v: string) => void
  textarea?: boolean
  className?: string
}>) {
  const fieldId = useId()
  const [draft, setDraft] = useState(value ?? '')

  function commit() {
    if (draft !== (value ?? '')) onSave(draft)
  }

  return (
    <div className={className}>
      <label
        htmlFor={fieldId}
        className="block text-[11px] uppercase tracking-wide mb-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </label>
      {textarea ? (
        <textarea
          id={fieldId}
          className="input text-xs w-full"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <Input
          id={fieldId}
          className="text-xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      )}
    </div>
  )
}
