'use client'

import { useState, useTransition, useActionState, useRef } from 'react'
import { Pencil, X, Check, Loader2, Upload, Users2, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CrewMember } from '@/types/database'
import type { ContactPref } from '@/types/database'
import {
  addCrewMember,
  updateCrewMember,
  deactivateCrewMember,
  inviteCrewMember,
  bulkImportCrew,
  type SettingsActionState,
} from '../settings/actions'

// ── Bulk upload helpers ───────────────────────────────────────────────────────

interface ParsedRow {
  name:      string
  email:     string
  phone:     string
  specialty: string
}

/** Detect email in a string */
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/

/** Detect phone (US-centric, flexible) */
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/

function parseCSV(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []

  // Detect header row
  const firstLower = lines[0].toLowerCase()
  const hasHeader  = firstLower.includes('name') || firstLower.includes('email')
  const dataLines  = hasHeader ? lines.slice(1) : lines

  // Try to find column indices from header
  const headers  = hasHeader ? lines[0].split(',').map((h) => h.trim().toLowerCase()) : []
  const nameIdx  = headers.findIndex((h) => h.includes('name'))
  const emailIdx = headers.findIndex((h) => h.includes('email'))
  const phoneIdx = headers.findIndex((h) => h.includes('phone') || h.includes('mobile'))
  const specIdx  = headers.findIndex((h) => h.includes('spec') || h.includes('role') || h.includes('skill'))

  return dataLines
    .map((line) => {
      // Handle quoted CSV fields
      const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g)
                     ?.map((c) => c.replace(/^"|"$/g, '').trim()) ?? line.split(',').map((c) => c.trim())

      // If headers found, use them; otherwise heuristic positional + regex
      let name      = nameIdx  >= 0 ? cols[nameIdx]  ?? '' : ''
      let email     = emailIdx >= 0 ? cols[emailIdx] ?? '' : ''
      let phone     = phoneIdx >= 0 ? cols[phoneIdx] ?? '' : ''
      let specialty = specIdx  >= 0 ? cols[specIdx]  ?? '' : ''

      // Heuristic fallback: scan all columns for email/phone, first non-match = name
      if (!name) {
        const candidates = cols.filter((c) => c && !EMAIL_RE.test(c) && !PHONE_RE.test(c))
        name = candidates[0] ?? ''
      }
      if (!email) {
        email = cols.find((c) => EMAIL_RE.test(c)) ?? ''
      }
      if (!phone) {
        phone = cols.find((c) => PHONE_RE.test(c)) ?? ''
      }

      return { name, email, phone, specialty }
    })
    .filter((r) => r.name)
}

function parsePastedText(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return lines.map((line) => {
    const emailMatch = line.match(EMAIL_RE)
    const phoneMatch = line.match(PHONE_RE)
    const email = emailMatch?.[0] ?? ''
    const phone = phoneMatch?.[0] ?? ''
    // Strip email and phone from line to isolate name
    const name = line
      .replace(email, '')
      .replace(phone, '')
      .replace(/[,|;–—:]/g, ' ')
      .trim()
      .replace(/\s+/, ' ')
    return { name, email, phone, specialty: '' }
  }).filter((r) => r.name)
}

// ── Root client component ─────────────────────────────────────────────────────

interface Props { crew: CrewMember[] }

type ViewMode = 'list' | 'add' | 'bulk'

export function CrewManageClient({ crew }: Props) {
  const [view, setView] = useState<ViewMode>('list')

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Users2 className="w-5 h-5" style={{ color: 'var(--accent-gold)' }} />
            <h2 className="text-base font-semibold text-primary-themed">
              Crew Members
              <span className="ml-2 badge badge-slate">{crew.length}</span>
            </h2>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setView(view === 'bulk' ? 'list' : 'bulk')}
              className="btn-secondary text-sm"
            >
              <Upload className="w-4 h-4" />
              {view === 'bulk' ? 'Cancel' : 'Bulk Upload'}
            </button>
            <button
              onClick={() => setView(view === 'add' ? 'list' : 'add')}
              className="btn-primary text-sm"
            >
              {view === 'add' ? 'Cancel' : '+ Add Member'}
            </button>
          </div>
        </div>

        {view === 'add'  && <AddCrewForm  onSuccess={() => setView('list')} />}
        {view === 'bulk' && <BulkCrewUpload onSuccess={() => setView('list')} />}

        {crew.length === 0 && view === 'list' ? (
          <div className="py-12 text-center">
            <Users2 className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm text-muted-themed">No active crew members yet.</p>
            <p className="text-xs text-muted-themed mt-1">Add one manually or bulk-upload a CSV.</p>
          </div>
        ) : view === 'list' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed">
                  {['Name','Specialty','Contact','Pref','App Access',''].map((h) => (
                    <th key={h}
                        className={cn('py-2 pr-4 font-medium text-muted-themed text-xs uppercase tracking-wide',
                                      h ? 'text-left' : 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {crew.map((member) => (
                  <CrewRow key={member.id} member={member} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Add single crew member ────────────────────────────────────────────────────

function AddCrewForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, formAction, pending] = useActionState(addCrewMember, null)

  if (state?.success) {
    onSuccess()
    return null
  }

  return (
    <div className="mb-6 p-4 rounded-lg border border-themed" style={{ background: 'var(--bg-canvas)' }}>
      <h3 className="text-sm font-semibold text-secondary-themed mb-3">New Crew Member</h3>

      {state?.error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="crew-name" className="label">Name <span className="text-red-400">*</span></label>
            <input id="crew-name" name="name" type="text" required className="input" placeholder="Alex Johnson" />
          </div>
          <div>
            <label htmlFor="crew-specialty" className="label">Specialty</label>
            <input id="crew-specialty" name="specialty" type="text" className="input" placeholder="e.g. Cleaning, HVAC" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="crew-email" className="label">Email</label>
            <input id="crew-email" name="email" type="email" className="input" placeholder="alex@example.com" />
          </div>
          <div>
            <label htmlFor="crew-phone" className="label">Phone</label>
            <input id="crew-phone" name="phone" type="tel" className="input" placeholder="+1 555-0100" />
          </div>
        </div>

        <div className="w-48">
          <label htmlFor="crew-pref" className="label">Preferred Contact</label>
          <select id="crew-pref" name="preferred_contact" className="input">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Both</option>
          </select>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary text-sm">
            {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add Crew Member'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Bulk upload ───────────────────────────────────────────────────────────────

function BulkCrewUpload({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode]         = useState<'csv' | 'paste'>('csv')
  const [preview, setPreview]   = useState<ParsedRow[] | null>(null)
  const [pasteText, setPaste]   = useState('')
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult]     = useState<{ imported: number; skipped: number } | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError(null)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const rows = parseCSV(text)
      if (!rows.length) {
        setError('No parseable rows found. Check that your file has Name, Email, and Phone columns.')
        setPreview(null)
      } else {
        setPreview(rows)
      }
    }
    reader.readAsText(file)
  }

  function handleParsePaste() {
    const rows = parsePastedText(pasteText)
    if (!rows.length) {
      setError('Could not extract any names from the pasted text.')
      setPreview(null)
    } else {
      setError(null)
      setPreview(rows)
    }
  }

  async function handleImport() {
    if (!preview?.length) return
    setImporting(true)
    setError(null)
    const res = await bulkImportCrew(preview)
    setImporting(false)
    if (res.error) {
      setError(res.error)
    } else {
      setResult({ imported: res.imported, skipped: res.skipped })
    }
  }

  if (result) {
    return (
      <div className="mb-6 p-5 rounded-lg border border-themed text-center"
           style={{ background: 'var(--bg-canvas)' }}>
        <div className="text-3xl font-bold mb-1" style={{ color: 'var(--accent-gold)' }}>
          {result.imported}
        </div>
        <p className="text-sm text-primary-themed font-medium">crew members imported</p>
        {result.skipped > 0 && (
          <p className="text-xs text-muted-themed mt-1">{result.skipped} rows skipped (missing name)</p>
        )}
        <button onClick={onSuccess} className="btn-primary text-sm mt-4">Done</button>
      </div>
    )
  }

  return (
    <div className="mb-6 p-4 rounded-lg border border-themed" style={{ background: 'var(--bg-canvas)' }}>
      <h3 className="text-sm font-semibold text-secondary-themed mb-3">Bulk Import Crew</h3>

      {/* Mode toggle */}
      <div className="flex gap-1 rounded-lg p-1 mb-4 w-fit" style={{ background: 'var(--bg-raised)' }}>
        <button
          onClick={() => { setMode('csv'); setPreview(null); setError(null) }}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
          style={mode === 'csv'
            ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
            : { color: 'var(--text-muted)' }}
        >
          CSV File
        </button>
        <button
          onClick={() => { setMode('paste'); setPreview(null); setError(null) }}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
          style={mode === 'paste'
            ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
            : { color: 'var(--text-muted)' }}
        >
          Paste from Doc
        </button>
      </div>

      {mode === 'csv' ? (
        <div>
          <p className="text-xs text-muted-themed mb-3">
            Upload a <strong className="text-secondary-themed">.csv</strong> file with columns for{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Name</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Email</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Phone</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Specialty</code>{' '}
            (optional). To use a Word doc, save it as CSV first or use Paste mode.
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 btn-secondary text-sm mb-2"
          >
            <FileText className="w-4 h-4" />
            {fileName || 'Choose .csv file'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={handleFile}
            className="hidden"
          />
        </div>
      ) : (
        <div>
          <p className="text-xs text-muted-themed mb-3">
            Paste text directly from your Word doc or any source. One person per line.
            Email and phone numbers are automatically detected.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPaste(e.target.value)}
            className="input text-xs font-mono h-32 resize-y mb-2"
            placeholder={"Alex Johnson, alex@example.com, 555-0101\nSarah Lee, 555-0102, sarah@example.com\n..."}
          />
          <button
            onClick={handleParsePaste}
            disabled={!pasteText.trim()}
            className="btn-secondary text-sm"
          >
            Parse Text
          </button>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs rounded-lg px-3 py-2"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {error}
        </div>
      )}

      {/* Preview table */}
      {preview && preview.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-secondary-themed">
              Preview — {preview.length} rows
            </p>
            <button onClick={() => setPreview(null)} className="text-xs text-muted-themed hover:text-primary-themed">
              Clear
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-themed max-h-56">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: 'var(--bg-raised)' }}>
                  {['Name','Email','Phone','Specialty'].map((h) => (
                    <th key={h} className="text-left py-2 px-3 font-medium text-muted-themed uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {preview.map((row, i) => (
                  <tr key={i} className="hover:bg-raised-themed">
                    <td className="py-1.5 px-3 text-primary-themed font-medium">{row.name || <span className="text-red-400">Missing</span>}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.email || '—'}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.phone || '—'}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.specialty || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleImport}
              disabled={importing}
              className="btn-primary text-sm"
            >
              {importing
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</>
                : `Import ${preview.length} Members`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Crew row ──────────────────────────────────────────────────────────────────

function CrewRow({ member }: { member: CrewMember }) {
  const [editing, setEditing]         = useState(false)
  const [name, setName]               = useState(member.name)
  const [specialty, setSpecialty]     = useState(member.specialty)
  const [email, setEmail]             = useState(member.email ?? '')
  const [phone, setPhone]             = useState(member.phone ?? '')
  const [pref, setPref]               = useState(member.preferred_contact)
  const [rowError, setRowError]       = useState<string | null>(null)
  const [saving, startSave]           = useTransition()
  const [deactivating, startDeact]    = useTransition()
  const [inviting, setInviting]       = useState(false)
  const [inviteSent, setInviteSent]   = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  async function handleInvite() {
    setInviting(true)
    setInviteError(null)
    const result = await inviteCrewMember(member.id)
    setInviting(false)
    if (result.error) setInviteError(result.error)
    else              setInviteSent(true)
  }

  function handleSave() {
    setRowError(null)
    startSave(async () => {
      const result = await updateCrewMember(member.id, {
        name, email: email || undefined, phone: phone || undefined, specialty,
        preferred_contact: pref,
      })
      if (result.error) setRowError(result.error)
      else              setEditing(false)
    })
  }

  function handleDeactivate() {
    startDeact(async () => { await deactivateCrewMember(member.id) })
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--bg-raised)' }}>
        <td className="py-2 pr-4">
          <input value={name} onChange={(e) => setName(e.target.value)} className="input py-1 text-sm" />
          {rowError && <p className="text-xs text-red-400 mt-1">{rowError}</p>}
        </td>
        <td className="py-2 pr-4">
          <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} className="input py-1 text-sm" placeholder="Specialty" />
        </td>
        <td className="py-2 pr-4">
          <div className="space-y-1">
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="input py-1 text-sm" placeholder="Email" type="email" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input py-1 text-sm" placeholder="Phone" type="tel" />
          </div>
        </td>
        <td className="py-2 pr-4">
          <select value={pref} onChange={(e) => setPref(e.target.value as typeof pref)} className="input py-1 text-sm">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Both</option>
          </select>
        </td>
        <td className="py-2 pr-4" />
        <td className="py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <button onClick={handleSave} disabled={saving} className="btn-primary py-1 px-2 text-xs" title="Save">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => setEditing(false)} className="btn-ghost py-1 px-2 text-xs" title="Cancel">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="hover:bg-raised-themed transition-colors">
      <td className="py-2.5 pr-4 font-medium text-primary-themed">{member.name}</td>
      <td className="py-2.5 pr-4 text-secondary-themed">{member.specialty || '—'}</td>
      <td className="py-2.5 pr-4 text-secondary-themed">
        <div className="space-y-0.5">
          {member.email && <div className="truncate max-w-[180px]">{member.email}</div>}
          {member.phone && <div>{member.phone}</div>}
          {!member.email && !member.phone && <span className="text-muted-themed">—</span>}
        </div>
      </td>
      <td className="py-2.5 pr-4">
        <span className="badge badge-slate capitalize">{member.preferred_contact}</span>
      </td>
      <td className="py-2.5 pr-4">
        {member.user_id ? (
          <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: 'var(--accent-green)' }} />
            Active
          </span>
        ) : inviteSent ? (
          <span className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>✓ Invite sent</span>
        ) : member.invite_sent_at ? (
          <button onClick={handleInvite} disabled={inviting}
                  className="text-xs underline underline-offset-2 disabled:opacity-50"
                  style={{ color: 'var(--text-muted)' }}>
            {inviting ? 'Sending…' : 'Resend invite'}
          </button>
        ) : (
          <button onClick={handleInvite} disabled={inviting || !member.email}
                  className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
                  title={!member.email ? 'Add an email address first' : undefined}>
            {inviting ? 'Sending…' : 'Invite to app'}
          </button>
        )}
        {inviteError && <p className="text-xs mt-0.5" style={{ color: 'var(--accent-red)' }}>{inviteError}</p>}
      </td>
      <td className="py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <button onClick={() => setEditing(true)} className="btn-ghost py-1 px-2 text-xs" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleDeactivate} disabled={deactivating} className="btn-danger py-1 px-2 text-xs" title="Deactivate">
            {deactivating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </button>
        </div>
      </td>
    </tr>
  )
}
