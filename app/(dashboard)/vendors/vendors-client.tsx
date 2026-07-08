'use client'

import { useState, useTransition, useActionState, useRef } from 'react'
import Link from 'next/link'
import { X, Loader2, Upload, Briefcase, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NudgeBanner } from '@/components/nudge-banner'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { Vendor, VendorSpecialty } from '@/types/database'
import {
  addVendor,
  updateVendor,
  updateVendorPortal,
  deactivateVendor,
  bulkImportVendors,
} from '../settings/actions'

// ── Constants ─────────────────────────────────────────────────────────────────

const VENDOR_SPECIALTY_LABELS: Record<VendorSpecialty, string> = {
  plumbing:     'Plumbing',
  electrical:   'Electrical',
  hvac:         'HVAC',
  landscaping:  'Landscaping',
  cleaning:     'Cleaning',
  pest_control: 'Pest Control',
  pool:         'Pool',
  roofing:      'Roofing',
  general:      'General',
  other:        'Other',
}

const VENDOR_SPECIALTIES = Object.keys(VENDOR_SPECIALTY_LABELS) as VendorSpecialty[]

// ── Bulk upload helpers ───────────────────────────────────────────────────────

interface ParsedVendor {
  name:         string
  contact_name: string
  email:        string
  phone:        string
  specialty:    string
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/

function parseCSV(text: string): ParsedVendor[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []

  const firstLower = lines[0].toLowerCase()
  const hasHeader  = firstLower.includes('name') || firstLower.includes('vendor')
  const dataLines  = hasHeader ? lines.slice(1) : lines
  const headers    = hasHeader ? lines[0].split(',').map((h) => h.trim().toLowerCase()) : []

  const nameIdx    = headers.findIndex((h) => h === 'name' || h === 'vendor name' || h === 'company')
  const contactIdx = headers.findIndex((h) => h.includes('contact'))
  const emailIdx   = headers.findIndex((h) => h.includes('email'))
  const phoneIdx   = headers.findIndex((h) => h.includes('phone') || h.includes('mobile'))
  const specIdx    = headers.findIndex((h) => h.includes('spec') || h.includes('type') || h.includes('category'))

  return dataLines.map((line) => {
    const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g)
                   ?.map((c) => c.replace(/^"|"$/g, '').trim()) ?? line.split(',').map((c) => c.trim())

    let name         = nameIdx    >= 0 ? cols[nameIdx]    ?? '' : ''
    let contact_name = contactIdx >= 0 ? cols[contactIdx] ?? '' : ''
    let email        = emailIdx   >= 0 ? cols[emailIdx]   ?? '' : ''
    let phone        = phoneIdx   >= 0 ? cols[phoneIdx]   ?? '' : ''
    // No regex fallback for specialty like the fields below — unlike
    // email/phone, free-text category values have no reliable pattern to
    // detect from an unlabeled column, so this is header-only.
    const specialty  = specIdx    >= 0 ? cols[specIdx]    ?? '' : ''

    if (!name) {
      const nonContact = cols.filter((c) => c && !EMAIL_RE.test(c) && !PHONE_RE.test(c))
      name = nonContact[0] ?? ''
      if (!contact_name) contact_name = nonContact[1] ?? ''
    }
    if (!email) email = cols.find((c) => EMAIL_RE.test(c)) ?? ''
    if (!phone) phone = cols.find((c) => PHONE_RE.test(c)) ?? ''

    return { name, contact_name, email, phone, specialty }
  }).filter((r) => r.name)
}

function parsePastedText(text: string): ParsedVendor[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return lines.map((line) => {
    const emailMatch = line.match(EMAIL_RE)
    const phoneMatch = line.match(PHONE_RE)
    const email = emailMatch?.[0] ?? ''
    const phone = phoneMatch?.[0] ?? ''
    const name  = line
      .replace(email, '')
      .replace(phone, '')
      .replace(/[,|;–—:]/g, ' ')
      .trim()
      .replace(/\s+/, ' ')
    return { name, contact_name: '', email, phone, specialty: '' }
  }).filter((r) => r.name)
}

// ── Root client component ─────────────────────────────────────────────────────

interface Props { vendors: Vendor[]; showComplianceNudge: boolean }

type ViewMode = 'list' | 'add' | 'bulk'

export function VendorsClient({ vendors, showComplianceNudge }: Props) {
  const [view, setView]                 = useState<ViewMode>('list')
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null)

  return (
    <div className="space-y-6">
      {showComplianceNudge && (
        <NudgeBanner
          id="compliance-vault-intro"
          message="Vendors without a current COI can be auto-blocked from new work orders."
          href={vendors.length > 0 ? `/vendors/${vendors[0]!.id}#compliance` : '/vendors'}
          linkText={vendors.length > 0 ? 'Add COI to first vendor →' : 'Add your first vendor →'}
        />
      )}
      <Card>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Briefcase className="w-5 h-5" style={{ color: 'var(--accent-gold)' }} />
            <h2 className="text-base font-semibold text-primary-themed">
              Vendors
              <Badge tone="slate" className="ml-2">{vendors.length}</Badge>
            </h2>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setView(view === 'bulk' ? 'list' : 'bulk')}
              className="text-sm"
            >
              <Upload className="w-4 h-4" />
              {view === 'bulk' ? 'Cancel' : 'Bulk Upload'}
            </Button>
            <Button
              onClick={() => setView(view === 'add' ? 'list' : 'add')}
              className="text-sm"
            >
              {view === 'add' ? 'Cancel' : '+ Add Vendor'}
            </Button>
          </div>
        </div>

        {view === 'add'  && <AddVendorForm  onSuccess={() => setView('list')} />}
        {view === 'bulk' && <BulkVendorUpload onSuccess={() => setView('list')} />}

        {vendors.length === 0 && view === 'list' ? (
          <div className="py-12 text-center">
            <Briefcase className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm text-muted-themed">No active vendors yet.</p>
            <p className="text-xs text-muted-themed mt-1">Add one manually or bulk-upload a CSV.</p>
          </div>
        ) : view === 'list' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed">
                  {['Name','Specialty','Contact','Portal',''].map((h) => (
                    <th key={h}
                        className={cn('py-2 pr-4 font-medium text-muted-themed text-xs uppercase tracking-wide',
                                      h ? 'text-left' : 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(
                  vendors.reduce<Record<string, (typeof vendors)>>((acc, v) => {
                    const key = v.specialty ?? 'other'
                    ;(acc[key] ??= []).push(v)
                    return acc
                  }, {})
                ).map(([specialty, group]) => (
                  <>
                    <tr key={`hdr-${specialty}`} style={{ background: 'var(--bg-raised)' }}>
                      <td colSpan={5} className="py-1.5 pr-4 pl-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-gold)' }}>
                        {VENDOR_SPECIALTY_LABELS[specialty as VendorSpecialty] ?? specialty}
                      </td>
                    </tr>
                    {group.map((v) => <VendorRow key={v.id} vendor={v} onSelect={setSelectedVendor} />)}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selectedVendor && (
        <VendorCardModal vendor={selectedVendor} onClose={() => setSelectedVendor(null)} />
      )}
    </div>
  )
}

// ── Vendor card modal ─────────────────────────────────────────────────────────

function VendorCardModal({ vendor, onClose }: { vendor: Vendor; onClose: () => void }) {
  const [editing, setEditing] = useState(false)
  const boundUpdate = updateVendor.bind(null, vendor.id)
  const [state, formAction, pending] = useActionState(boundUpdate, null)

  if (state?.success) { onClose(); return null }

  return (
    <Dialog open onClose={onClose} title={vendor.name} maxWidthClassName="max-w-sm">
        {!editing && (
          <div className="flex items-center justify-between mb-4">
            <Badge tone="blue">{VENDOR_SPECIALTY_LABELS[vendor.specialty]}</Badge>
            <Button variant="ghost" onClick={() => setEditing(true)} className="p-1.5 text-xs">Edit</Button>
          </div>
        )}

        {state?.error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-3"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
            {state.error}
          </div>
        )}

        {editing ? (
          <form action={formAction} className="space-y-3">
            <div>
              <label className="label">Vendor Name</label>
              <Input name="name" type="text" required defaultValue={vendor.name} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Contact Name</label>
                <Input name="contact_name" type="text" defaultValue={vendor.contact_name ?? ''} />
              </div>
              <div>
                <label className="label">Specialty</label>
                <select name="specialty" defaultValue={vendor.specialty} className="input">
                  {VENDOR_SPECIALTIES.map((s) => (
                    <option key={s} value={s}>{VENDOR_SPECIALTY_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Email</label>
                <Input name="email" type="email" defaultValue={vendor.email ?? ''} />
              </div>
              <div>
                <label className="label">Phone</label>
                <Input name="phone" type="tel" defaultValue={vendor.phone ?? ''} />
              </div>
            </div>
            <div>
              <label className="label">Street Address</label>
              <Input name="address" type="text" defaultValue={vendor.address ?? ''} placeholder="123 Main St" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">City</label>
                <Input name="city" type="text" defaultValue={vendor.city ?? ''} placeholder="Atlanta" />
              </div>
              <div>
                <label className="label">State</label>
                <Input name="state" type="text" defaultValue={vendor.state ?? ''} placeholder="GA" maxLength={2} />
              </div>
            </div>
            <div>
              <label className="label">Service ZIP</label>
              <Input name="service_zip" type="text" defaultValue={vendor.service_zip ?? ''} placeholder="e.g. 30301" maxLength={10} />
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea name="notes" rows={2} defaultValue={vendor.notes ?? ''} className="input resize-none" />
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="submit" disabled={pending} className="text-sm flex-1">
                {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save Changes'}
              </Button>
              <Button variant="ghost" type="button" onClick={() => setEditing(false)} className="text-sm">Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="space-y-2 text-sm">
            {vendor.contact_name && (
              <div className="flex justify-between">
                <span className="text-muted-themed">Contact</span>
                <span className="text-secondary-themed">{vendor.contact_name}</span>
              </div>
            )}
            {vendor.phone && (
              <div className="flex justify-between">
                <span className="text-muted-themed">Phone</span>
                <a href={`tel:${vendor.phone}`} className="text-accent-blue hover:underline">{vendor.phone}</a>
              </div>
            )}
            {vendor.email && (
              <div className="flex justify-between">
                <span className="text-muted-themed">Email</span>
                <a href={`mailto:${vendor.email}`}
                   className="text-accent-blue hover:underline truncate max-w-[180px]">
                  {vendor.email}
                </a>
              </div>
            )}
            {(vendor.address || vendor.city || vendor.state) && (
              <div className="flex justify-between">
                <span className="text-muted-themed">Address</span>
                <span className="text-secondary-themed text-right">
                  {vendor.address && <span className="block">{vendor.address}</span>}
                  {(vendor.city || vendor.state) && (
                    <span className="block">{[vendor.city, vendor.state].filter(Boolean).join(', ')}</span>
                  )}
                </span>
              </div>
            )}
            {vendor.service_zip && (
              <div className="flex justify-between">
                <span className="text-muted-themed">Service ZIP</span>
                <span className="text-secondary-themed">{vendor.service_zip}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-themed">Vendor Portal</span>
              <span style={{ color: vendor.portal_enabled ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                {vendor.portal_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-themed">On-Time Completion</span>
              <span className="text-secondary-themed">
                {vendor.on_time_pct !== null
                  ? `${vendor.on_time_pct}% (${vendor.on_time_sample_size} jobs)`
                  : 'Not enough data yet'}
              </span>
            </div>
            {vendor.notes && (
              <div>
                <p className="text-muted-themed mb-1">Notes</p>
                <p className="text-secondary-themed text-xs">{vendor.notes}</p>
              </div>
            )}
          </div>
        )}
    </Dialog>
  )
}

// ── Add single vendor ─────────────────────────────────────────────────────────

function AddVendorForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, formAction, pending] = useActionState(addVendor, null)

  if (state?.success) {
    onSuccess()
    return null
  }

  return (
    <div className="mb-6 p-4 rounded-lg border border-themed" style={{ background: 'var(--bg-canvas)' }}>
      <h3 className="text-sm font-semibold text-secondary-themed mb-3">New Vendor</h3>

      {state?.error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-name" className="label">Vendor Name <span className="text-red-400">*</span></label>
            <Input id="vendor-name" name="name" type="text" required placeholder="ABC Plumbing" />
          </div>
          <div>
            <label htmlFor="vendor-contact" className="label">Contact Name</label>
            <Input id="vendor-contact" name="contact_name" type="text" placeholder="John Smith" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-email" className="label">Email <span className="text-red-400">*</span></label>
            <Input id="vendor-email" name="email" type="email" required placeholder="info@abcplumbing.com" />
          </div>
          <div>
            <label htmlFor="vendor-phone" className="label">Mobile phone number</label>
            <Input id="vendor-phone" name="phone" type="tel" placeholder="+1 555-0100" />
            <p className="text-xs text-muted-themed mt-1">
              Work orders will be dispatched to this number by SMS in addition to email.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-specialty" className="label">Specialty</label>
            <select id="vendor-specialty" name="specialty" className="input">
              {VENDOR_SPECIALTIES.map((s) => (
                <option key={s} value={s}>{VENDOR_SPECIALTY_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="vendor-zip" className="label">Service ZIP</label>
            <Input id="vendor-zip" name="service_zip" type="text" placeholder="e.g. 30301" maxLength={10} />
          </div>
        </div>

        <div>
          <label htmlFor="vendor-address" className="label">Street Address</label>
          <Input id="vendor-address" name="address" type="text" placeholder="123 Main St" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-city" className="label">City</label>
            <Input id="vendor-city" name="city" type="text" placeholder="Atlanta" />
          </div>
          <div>
            <label htmlFor="vendor-state" className="label">State</label>
            <Input id="vendor-state" name="state" type="text" placeholder="GA" maxLength={2} />
          </div>
        </div>

        <div className="flex items-center pb-1">
          <label className="flex items-center gap-2 cursor-pointer text-sm text-secondary-themed">
            <input
              type="checkbox"
              name="portal_enabled"
              defaultChecked
              className="w-4 h-4 rounded"
              style={{ accentColor: 'var(--accent-gold)' }}
            />
            Enable vendor portal
          </label>
        </div>

        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={pending} className="text-sm">
            {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : 'Add Vendor'}
          </Button>
        </div>
      </form>
    </div>
  )
}

// ── Bulk upload ───────────────────────────────────────────────────────────────

function BulkVendorUpload({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode]         = useState<'csv' | 'paste'>('csv')
  const [preview, setPreview]   = useState<ParsedVendor[] | null>(null)
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
        setError('No parseable rows found. Check your file has Name, Email, and Phone columns.')
        setPreview(null)
      } else {
        setPreview(rows)
      }
    }
    reader.readAsText(file)
  }

  function handleParsePaste() {
    const rows = parsePastedText(pasteText)
    if (!rows.length) { setError('Could not extract any names.'); setPreview(null) }
    else { setError(null); setPreview(rows) }
  }

  async function handleImport() {
    if (!preview?.length) return
    setImporting(true)
    const res = await bulkImportVendors(preview)
    setImporting(false)
    if (res.error) setError(res.error)
    else setResult({ imported: res.imported, skipped: res.skipped })
  }

  if (result) {
    return (
      <div className="mb-6 p-5 rounded-lg border border-themed text-center"
           style={{ background: 'var(--bg-canvas)' }}>
        <div className="text-3xl font-bold mb-1" style={{ color: 'var(--accent-gold)' }}>{result.imported}</div>
        <p className="text-sm text-primary-themed font-medium">vendors imported</p>
        {result.skipped > 0 && <p className="text-xs text-muted-themed mt-1">{result.skipped} rows skipped</p>}
        <Button onClick={onSuccess} className="text-sm mt-4">Done</Button>
      </div>
    )
  }

  return (
    <div className="mb-6 p-4 rounded-lg border border-themed" style={{ background: 'var(--bg-canvas)' }}>
      <h3 className="text-sm font-semibold text-secondary-themed mb-3">Bulk Import Vendors</h3>

      <div className="flex gap-1 rounded-lg p-1 mb-4 w-fit" style={{ background: 'var(--bg-raised)' }}>
        {(['csv','paste'] as const).map((m) => (
          <button key={m} onClick={() => { setMode(m); setPreview(null); setError(null) }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  style={mode === m
                    ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                    : { color: 'var(--text-muted)' }}>
            {m === 'csv' ? 'CSV File' : 'Paste from Doc'}
          </button>
        ))}
      </div>

      {mode === 'csv' ? (
        <div>
          <p className="text-xs text-muted-themed mb-3">
            Upload a <strong className="text-secondary-themed">.csv</strong> file with columns for{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Name</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Contact</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Email</code>,{' '}
            <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--bg-raised)' }}>Phone</code>.
            To use a Word doc, save as CSV or use Paste mode.
          </p>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} className="flex items-center gap-2 text-sm mb-2">
            <FileText className="w-4 h-4" />
            {fileName || 'Choose .csv file'}
          </Button>
          <Input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={handleFile} className="hidden" />
        </div>
      ) : (
        <div>
          <p className="text-xs text-muted-themed mb-3">
            Paste text from your Word doc. One vendor per line with their name, email, and phone.
          </p>
          <textarea value={pasteText} onChange={(e) => setPaste(e.target.value)}
                    className="input text-xs font-mono h-32 resize-y mb-2"
                    placeholder={"ABC Plumbing, John Smith, 555-0101, john@abcplumbing.com\n..."} />
          <Button variant="secondary" onClick={handleParsePaste} disabled={!pasteText.trim()} className="text-sm">Parse Text</Button>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs rounded-lg px-3 py-2"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {error}
        </div>
      )}

      {preview && preview.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-secondary-themed">Preview — {preview.length} rows</p>
            <button onClick={() => setPreview(null)} className="text-xs text-muted-themed hover:text-primary-themed">Clear</button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-themed max-h-56">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: 'var(--bg-raised)' }}>
                  {['Name','Contact','Email','Phone','Specialty'].map((h) => (
                    <th key={h} className="text-left py-2 px-3 font-medium text-muted-themed uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {preview.map((row, i) => (
                  <tr key={i} className="hover:bg-raised-themed">
                    <td className="py-1.5 px-3 text-primary-themed font-medium">{row.name || <span className="text-red-400">Missing</span>}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.contact_name || '—'}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.email || '—'}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.phone || '—'}</td>
                    <td className="py-1.5 px-3 text-secondary-themed">{row.specialty || 'general'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Button onClick={handleImport} disabled={importing} className="text-sm">
              {importing ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</> : `Import ${preview.length} Vendors`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Star rating ───────────────────────────────────────────────────────────────

const STAR_PATH = 'M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.563.563 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z'

function StarRating({ rating, count }: { rating: number | null; count: number }) {
  if (!rating || count === 0) {
    return (
      <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
        <span className="flex">
          {[1,2,3,4,5].map((s) => (
            <svg key={s} className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"
                 style={{ color: 'var(--border-strong)' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d={STAR_PATH} />
            </svg>
          ))}
        </span>
        <span>No ratings</span>
      </span>
    )
  }

  const full  = Math.floor(rating)
  const half  = rating - full >= 0.5
  const empty = 5 - full - (half ? 1 : 0)

  return (
    <span className="text-xs flex items-center gap-1">
      <span className="flex">
        {Array.from({ length: full }).map((_, i) => (
          <svg key={`f${i}`} className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"
               style={{ color: 'var(--accent-gold)' }}>
            <path d={STAR_PATH} />
          </svg>
        ))}
        {half && (
          <svg key="half" className="w-3 h-3" viewBox="0 0 24 24" style={{ color: 'var(--accent-gold)' }}>
            <defs>
              <linearGradient id="halfGrad">
                <stop offset="50%" stopColor="currentColor"/>
                <stop offset="50%" stopColor="transparent"/>
              </linearGradient>
            </defs>
            <path fill="url(#halfGrad)" stroke="currentColor" strokeWidth={1.5} d={STAR_PATH} />
          </svg>
        )}
        {Array.from({ length: empty }).map((_, i) => (
          <svg key={`e${i}`} className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"
               style={{ color: 'var(--border-strong)' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d={STAR_PATH} />
          </svg>
        ))}
      </span>
      <span style={{ color: 'var(--text-muted)' }}>{rating.toFixed(1)} ({count})</span>
    </span>
  )
}

// ── Vendor row ────────────────────────────────────────────────────────────────

function VendorRow({ vendor, onSelect }: { vendor: Vendor & { work_orders?: Array<{ vendor_rating: number | null }>; on_time_pct?: number | null; on_time_sample_size?: number }; onSelect?: (v: Vendor) => void }) {
  const [portalEnabled, setPortalEnabled] = useState(vendor.portal_enabled)
  const [togglingPortal, startToggle]     = useTransition()
  const [deactivating,   startDeact]      = useTransition()

  function handleTogglePortal() {
    const next = !portalEnabled
    setPortalEnabled(next)
    startToggle(async () => { await updateVendorPortal(vendor.id, next) })
  }

  function handleDeactivate() {
    startDeact(async () => { await deactivateVendor(vendor.id) })
  }

  return (
    <tr className="hover:bg-raised-themed transition-colors cursor-pointer"
        onClick={() => onSelect?.(vendor)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(vendor) } }}>
      <td className="py-2.5 pr-4">
        <div className="font-medium text-primary-themed">{vendor.name}</div>
        {vendor.contact_name && <div className="text-xs text-muted-themed">{vendor.contact_name}</div>}
        <StarRating rating={vendor.avg_rating ?? null} count={vendor.rating_count ?? 0} />
        {vendor.on_time_pct !== null && vendor.on_time_pct !== undefined ? (
          <span className="text-xs text-muted-themed">
            {vendor.on_time_pct}% on-time ({vendor.on_time_sample_size})
          </span>
        ) : (
          <span className="text-xs text-muted-themed">Not enough data yet</span>
        )}
      </td>
      <td className="py-2.5 pr-4">
        <Badge tone="blue">{VENDOR_SPECIALTY_LABELS[vendor.specialty]}</Badge>
      </td>
      <td className="py-2.5 pr-4 text-secondary-themed">
        <div className="space-y-0.5">
          {vendor.email && <div className="truncate max-w-[180px]">{vendor.email}</div>}
          {vendor.phone && <div>{vendor.phone}</div>}
          {!vendor.email && !vendor.phone && <span className="text-muted-themed">—</span>}
        </div>
        {/* SMS / Email channel indicator */}
        <div className="flex items-center gap-2 mt-1.5">
          {vendor.phone && (
            <Badge tone="green" style={{ fontSize: 10, padding: '2px 7px' }}>
              SMS Active
            </Badge>
          )}
          {!vendor.phone && vendor.email && (
            <Badge tone="slate" style={{ fontSize: 10, padding: '2px 7px' }}>
              Email only
            </Badge>
          )}
        </div>
      </td>
      <td className="py-2.5 pr-4" onClick={e => e.stopPropagation()}>
        <button
          onClick={handleTogglePortal}
          disabled={togglingPortal}
          className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50"
          style={{ background: portalEnabled ? 'var(--accent-gold)' : 'var(--bg-raised)' }}
          role="switch"
          aria-checked={portalEnabled}
          title={portalEnabled ? 'Disable vendor portal' : 'Enable vendor portal'}
        >
          <span
            className="inline-block h-3.5 w-3.5 rounded-full shadow transition-transform"
            style={{
              background:  'white',
              transform:   portalEnabled ? 'translateX(1.125rem)' : 'translateX(0.125rem)',
            }}
          />
        </button>
      </td>
      <td className="py-2.5 text-right" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/vendors/${vendor.id}`}
            className="btn-secondary py-1 px-2 text-xs"
            title="View compliance docs"
          >
            Details
          </Link>
          <Button variant="danger" onClick={handleDeactivate} disabled={deactivating} className="py-1 px-2 text-xs" title="Deactivate vendor">
            {deactivating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </td>
    </tr>
  )
}
