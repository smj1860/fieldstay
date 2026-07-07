'use client'

import { useState, useTransition, useActionState } from 'react'
import { Plus, X, CheckCircle2, Loader2, ExternalLink, Shield, ShieldOff, ShieldCheck, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { createComplianceDocument, deleteComplianceDocument, verifyComplianceDocument } from '../actions'
import type { ComplianceDocActionState } from '../actions'
import type { VendorComplianceDocument, ComplianceDocType } from '@/types/database'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<ComplianceDocType, string> = {
  coi:                 'Certificate of Insurance',
  workers_comp:        'Workers Comp',
  business_license:    'Business License',
  contractor_license:  'Contractor License',
  bonding:             'Bonding',
  other:               'Other',
}

const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as ComplianceDocType[]

// ── Add document form ─────────────────────────────────────────────────────────

function AddDocumentForm({
  vendorId,
  orgId,
  onClose,
}: {
  vendorId: string
  orgId:    string
  onClose:  () => void
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const boundCreate = createComplianceDocument.bind(null, vendorId)
  const [state, formAction, pending] = useActionState(
    boundCreate,
    null as ComplianceDocActionState | null
  )

  if (state?.success) { onClose(); return null }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    setUploadError(null)

    const supabase = createClient()
    const ext  = file.name.split('.').pop() ?? 'pdf'
    const path = `${orgId}/${vendorId}/${Date.now()}-${crypto.randomUUID()}.${ext}`

    const { error } = await supabase.storage
      .from('compliance-documents')
      .upload(path, file, { contentType: file.type })

    if (error) {
      setUploadError(error.message)
      setUploading(false)
      return
    }

    const { data: { publicUrl } } = supabase.storage
      .from('compliance-documents')
      .getPublicUrl(path)

    setUploadedUrl(publicUrl)
    setUploading(false)
  }

  return (
    <Dialog open onClose={onClose} title="Add Compliance Document" maxWidthClassName="max-w-lg">
      <div className="max-h-[70vh] overflow-y-auto -mx-6 px-6">
        {state?.error && (
          <div className="text-sm rounded-lg px-3 py-2 mb-4"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          {/* Pass uploaded URL as hidden input */}
          <input type="hidden" name="document_url" value={uploadedUrl ?? ''} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="document-type" className="label">Document Type <span className="text-red-500">*</span></label>
              <select id="document-type" name="document_type" required className="input">
                <option value="">Select type…</option>
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="document-name" className="label">Document Name <span className="text-red-500">*</span></label>
              <Input id="document-name" name="document_name" type="text" required
                     placeholder='e.g. "General Liability COI 2025"' />
            </div>

            <div>
              <label htmlFor="policy-number" className="label">Policy / License Number</label>
              <Input id="policy-number" name="policy_number" type="text" />
            </div>

            <div>
              <label htmlFor="issuer-name" className="label">Issuing Company</label>
              <Input id="issuer-name" name="issuer_name" type="text" placeholder="e.g. State Farm" />
            </div>

            <div>
              <label htmlFor="effective-date" className="label">Effective Date</label>
              <Input id="effective-date" name="effective_date" type="date" />
            </div>

            <div>
              <label htmlFor="expiry-date" className="label">Expiry Date</label>
              <Input id="expiry-date" name="expiry_date" type="date" />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="coverage-amount" className="label">Coverage Amount ($)</label>
              <Input id="coverage-amount" name="coverage_amount" type="number" min="0" step="1000" placeholder="0" />
            </div>

            {/* File upload */}
            <div className="sm:col-span-2">
              <label htmlFor="document-file" className="label">Upload Document (PDF, image)</label>
              <Input
                id="document-file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                className="py-2 text-sm"
                onChange={handleFileUpload}
                disabled={uploading}
              />
              {uploading && (
                <p className="text-xs text-muted-themed mt-1 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
                </p>
              )}
              {uploadedUrl && (
                <p className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
                  <CheckCircle2 className="w-3 h-3" /> File uploaded
                </p>
              )}
              {uploadError && (
                <p className="text-xs mt-1" style={{ color: 'var(--accent-red)' }}>{uploadError}</p>
              )}
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              disabled={pending || uploading}
              className="flex items-center gap-2"
            >
              {pending ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Add Document'}
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}

// ── Compliance status badge ───────────────────────────────────────────────────

function statusForDoc(doc: VendorComplianceDocument): {
  label: string
  color: string
  bg:    string
} {
  if (!doc.expiry_date) return { label: 'No Expiry', color: 'var(--text-muted)', bg: 'var(--bg-raised)' }
  const daysUntil = Math.floor(
    (new Date(doc.expiry_date).getTime() - Date.now()) / 86_400_000
  )
  if (daysUntil < 0)  return { label: 'Expired',       color: 'var(--accent-red)',   bg: 'var(--accent-red-dim)'   }
  if (daysUntil < 30) return { label: 'Expiring Soon', color: 'var(--accent-amber)', bg: 'var(--accent-amber-dim)' }
  return { label: 'Active',          color: 'var(--accent-green)', bg: 'rgba(34,197,94,0.1)'    }
}

// ── Compliance section ────────────────────────────────────────────────────────

export function ComplianceSection({
  vendorId,
  orgId,
  documents,
}: {
  vendorId:  string
  orgId:     string
  documents: VendorComplianceDocument[]
}) {
  const [showAdd, setShowAdd]     = useState(false)
  const [removing, startRemove]   = useTransition()
  const [verifying, startVerify]  = useTransition()
  const [actingId, setActingId]   = useState<string | null>(null)

  const activeDocs   = documents.filter((d) => d.is_active)
  const expiredCount = activeDocs.filter((d) => d.expiry_date && new Date(d.expiry_date) < new Date()).length
  const soonCount    = activeDocs.filter((d) => {
    if (!d.expiry_date) return false
    const days = Math.floor((new Date(d.expiry_date).getTime() - Date.now()) / 86_400_000)
    return days >= 0 && days < 30
  }).length

  return (
    <>
      <Card className="mt-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-primary-themed">Compliance Documents</h3>
            {activeDocs.length > 0 && (
              <Badge tone="slate">{activeDocs.length}</Badge>
            )}
          </div>
          <Button onClick={() => setShowAdd(true)} className="text-sm">
            <Plus className="w-4 h-4" /> Add Document
          </Button>
        </div>

        {expiredCount > 0 && (
          <div className="text-sm rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5"
               style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
            <ShieldOff className="w-4 h-4 flex-shrink-0" />
            {expiredCount} document{expiredCount > 1 ? 's' : ''} expired — this vendor may be blocked from new WO assignments.
          </div>
        )}
        {soonCount > 0 && expiredCount === 0 && (
          <div className="text-sm rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5"
               style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {soonCount} document{soonCount > 1 ? 's' : ''} expiring within 30 days.
          </div>
        )}

        {activeDocs.length === 0 ? (
          <p className="text-sm text-muted-themed text-center py-6">
            No compliance documents on file. Add a COI or license to enable this vendor for WO assignments.
          </p>
        ) : (
          <div className="divide-y divide-themed">
            {activeDocs.map((doc) => {
              const { label, color, bg } = statusForDoc(doc)
              return (
                <div key={doc.id} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-primary-themed">{doc.document_name}</span>
                      <Badge tone="slate" className="text-xs">{DOC_TYPE_LABELS[doc.document_type]}</Badge>
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                        style={{ color, background: bg, border: `1px solid ${color}44` }}
                      >
                        {doc.expiry_date && new Date(doc.expiry_date) < new Date()
                          ? <ShieldOff className="w-3 h-3" />
                          : <Shield className="w-3 h-3" />
                        }
                        {label}
                      </span>
                      {doc.is_verified && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                              style={{ color: 'var(--accent-green)', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
                          <CheckCircle2 className="w-3 h-3" /> Verified
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-themed">
                      {doc.issuer_name    && <span>{doc.issuer_name}</span>}
                      {doc.policy_number  && <span>#{doc.policy_number}</span>}
                      {doc.effective_date && <span>Eff: {doc.effective_date}</span>}
                      {doc.expiry_date    && <span>Exp: {doc.expiry_date}</span>}
                      {doc.coverage_amount != null && (
                        <span>${doc.coverage_amount.toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {doc.document_url && (
                      <a
                        href={doc.document_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-ghost p-1.5"
                        title="View document"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {!doc.is_verified && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setActingId(doc.id)
                          startVerify(async () => {
                            const result = await verifyComplianceDocument(doc.id, vendorId)
                            if (result?.error) throw new Error(result.error)
                          })
                        }}
                        disabled={verifying && actingId === doc.id}
                        className="p-1.5 text-xs"
                        title="Mark verified"
                      >
                        {verifying && actingId === doc.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <ShieldCheck className="w-3.5 h-3.5" />
                        }
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setActingId(doc.id)
                        startRemove(() => deleteComplianceDocument(doc.id, vendorId))
                      }}
                      disabled={removing && actingId === doc.id}
                      className="p-1.5 text-muted-themed hover:text-red-500"
                      title="Remove document"
                    >
                      {removing && actingId === doc.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />
                      }
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {showAdd && (
        <AddDocumentForm
          vendorId={vendorId}
          orgId={orgId}
          onClose={() => setShowAdd(false)}
        />
      )}
    </>
  )
}
