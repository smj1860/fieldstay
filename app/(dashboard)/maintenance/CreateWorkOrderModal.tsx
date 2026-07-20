'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, Info, ShieldOff, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createWorkOrder } from './actions'
import { distanceMiles } from '@/lib/geocoding'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'
import type {
  CrewMemberOption, AssetOption, VendorComplianceRow,
  PropertyOptionWithCoords, VendorOptionWithCoords,
} from './maintenance-board'
import type { ComplianceStatus } from '@/types/database'

/**
 * The "New Work Order" creation form — extracted out of
 * maintenance-board.tsx, which used to conflate this ~470-line form with
 * the board itself in one 2618-line file.
 */
export function CreateWorkOrderModal({
  properties,
  vendors,
  crewMembers = [],
  propertyAssets = [],
  vendorCompliance = [],
  orgId = '',
  onClose,
  onWarning,
}: Readonly<{
  properties:       PropertyOptionWithCoords[]
  vendors:          VendorOptionWithCoords[]
  crewMembers?:     CrewMemberOption[]
  propertyAssets?:  AssetOption[]
  vendorCompliance?: VendorComplianceRow[]
  orgId?:           string
  onClose:          () => void
  onWarning?:       (msg: string) => void
}>) {
  const [state, action, pending]          = useActionState(createWorkOrder, null)
  const [assignMode,         setAssignMode]         = useState<'vendor' | 'crew' | 'quotes'>('vendor')
  const [selectedVendor,     setSelectedVendor]     = useState('')
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const [selectedQuoteVendors, setSelectedQuoteVendors] = useState<string[]>([])
  const [photoFiles,         setPhotoFiles]         = useState<File[]>([])
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null
  const assetsForProperty = propertyAssets.filter((a) => a.property_id === selectedPropertyId)

  const complianceFor = (vendorId: string): ComplianceStatus | null =>
    vendorCompliance.find((c) => c.vendor_id === vendorId)?.compliance_status ?? null

  const vendorDistance = (vendorId: string): number | null => {
    if (!selectedProperty?.lat || !selectedProperty?.lng) return null
    const v = vendors.find((vv) => vv.id === vendorId)
    if (!v?.lat || !v?.lng) return null
    return distanceMiles(selectedProperty.lat, selectedProperty.lng, v.lat, v.lng)
  }

  const selectedCompliance = selectedVendor ? complianceFor(selectedVendor) : null

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setPhotoFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const removePhoto = (i: number) =>
    setPhotoFiles(prev => prev.filter((_, idx) => idx !== i))

  // After successful WO creation, upload photos
  useEffect(() => {
    if (!state?.success || !state.workOrderId) return

    if (state.warning) onWarning?.(state.warning)

    // No photos attached — close immediately
    if (!photoFiles.length) {
      onClose()
      return
    }

    // Photos to upload — upload then close
    const workOrderId = state.workOrderId
    ;(async () => {
      const supabase = createClient()
      let photoFailures = 0
      for (const file of photoFiles) {
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `wo-${workOrderId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('work-order-photos')
          .upload(path, file, { contentType: file.type })
        if (uploadErr) {
          console.error('[CreateWorkOrderModal] Failed to upload photo:', uploadErr)
          photoFailures++
          continue
        }
        const { error: photoError } = await supabase.from('work_order_photos').insert({
          work_order_id: workOrderId,
          org_id:        orgId,
          storage_path:  path,
        })
        if (photoError) {
          console.error('[CreateWorkOrderModal] Failed to attach photos:', photoError)
          photoFailures++
        }
      }
      // Non-fatal — the WO was created; only photo attachment failed. Surface a
      // non-blocking warning via the existing toast rather than failing the modal.
      if (photoFailures > 0) {
        onWarning?.('Work order created, but some photos could not be attached. You can add them from the work order detail page.')
      }
      onClose()
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.success, state?.workOrderId])

  const toggleQuoteVendor = (id: string) => {
    setSelectedQuoteVendors((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
    )
  }

  return (
    <Dialog open onClose={onClose} title="New Work Order" maxWidthClassName="max-w-3xl">
        <form action={action} className="flex flex-col max-h-[85vh] -m-6">
          {/* Hidden fields for mode */}
          <input type="hidden" name="request_quotes" value={assignMode === 'quotes' ? 'true' : 'false'} />
          {assignMode === 'quotes' && selectedQuoteVendors.map((id) => (
            <input key={id} type="hidden" name="quote_vendor_ids" value={id} />
          ))}

          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">

          {state?.error && (
            <InlineAlert tone="error">
              {state.error}
            </InlineAlert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left column */}
            <div className="space-y-4">
              {/* Title */}
              <div>
                <label htmlFor="wo-title" className="label">
                  Title <RequiredMark />
                </label>
                <Input
                  id="wo-title"
                  name="title"
                  type="text"
                  required
                  placeholder="e.g. Fix leaking faucet in master bath"
                />
              </div>

              {/* Property */}
              <div>
                <label htmlFor="wo-property" className="label">
                  Property <RequiredMark />
                </label>
                <select
                  id="wo-property"
                  name="property_id"
                  required
                  className="input"
                  value={selectedPropertyId}
                  onChange={(e) => setSelectedPropertyId(e.target.value)}
                >
                  <option value="">Select property…</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              {/* Linked Asset */}
              {assetsForProperty.length > 0 && (
                <div>
                  <label htmlFor="wo-asset" className="label">Linked Asset</label>
                  <select id="wo-asset" name="asset_id" className="input">
                    <option value="">None</option>
                    {assetsForProperty.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} — {a.asset_type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Description */}
              <div>
                <label htmlFor="wo-desc" className="label">Description</label>
                <textarea
                  id="wo-desc"
                  name="description"
                  rows={4}
                  className="input resize-none"
                  placeholder="Details about the issue or task…"
                />
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              {/* Priority + Category */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="wo-priority" className="label">Priority</label>
                  <select id="wo-priority" name="priority" defaultValue="medium" className="input">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="wo-category" className="label">
                    Category
                    <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                      Needed for vendor suggestions
                    </span>
                  </label>
                  <select id="wo-category" name="category" defaultValue="" className="input">
                    <option value="">Uncategorized</option>
                    <option value="hvac">HVAC</option>
                    <option value="plumbing">Plumbing</option>
                    <option value="electrical">Electrical</option>
                    <option value="appliance">Appliance</option>
                    <option value="cleaning">Cleaning</option>
                    <option value="landscaping">Landscaping</option>
                    <option value="roofing">Roofing</option>
                    <option value="flooring">Flooring</option>
                    <option value="windows_doors">Windows/Doors</option>
                    <option value="pest_control">Pest Control</option>
                    <option value="pool">Pool</option>
                    <option value="structural">Structural</option>
                    <option value="general">General</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              {/* Scheduled date + NTE */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="wo-date" className="label">Completed By Date</label>
                  <Input id="wo-date" name="scheduled_date" type="date" />
                  <label htmlFor="wo-time" className="label mt-3">
                    Scheduled time
                    <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                      Optional — use for same-day flip vendor windows
                    </span>
                  </label>
                  <Input id="wo-time" name="scheduled_time" type="time" />
                </div>
                <div>
                  <label htmlFor="wo-nte" className="label">
                    NTE ($)
                    <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                      ceiling
                    </span>
                  </label>
                  <Input
                    id="wo-nte"
                    name="nte_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </div>
              </div>

              {/* Assignment mode */}
              <div>
                <label className="label">Assign To</label>
            <div className="flex gap-1 rounded-lg border border-themed p-1 mb-3">
              {vendors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('vendor')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'vendor' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'vendor' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Vendor
                </button>
              )}
              {crewMembers.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('crew')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'crew' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'crew' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Internal Crew
                </button>
              )}
              {vendors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('quotes')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'quotes' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'quotes' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Request quotes
                </button>
              )}
            </div>

          {assignMode === 'crew' ? (
            <select name="assigned_crew_member_id" className="input">
              <option value="">Select crew member…</option>
              {crewMembers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.role ? ` — ${c.role}` : ''}</option>
              ))}
            </select>
          ) : (
            <>

              {assignMode !== 'quotes' ? (
                <>
                  <select
                    id="wo-vendor"
                    name="vendor_id"
                    className="input"
                    value={selectedVendor}
                    onChange={(e) => setSelectedVendor(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {vendors.map((v) => {
                      const status = complianceFor(v.id)
                      const dist   = vendorDistance(v.id)
                      const blocked = status === 'hard_blocked'
                      const label  = [
                        v.name,
                        dist != null ? `${dist.toFixed(1)} mi` : null,
                        blocked ? 'Blocked' : status === 'expiring_soon' ? 'Expiring' : null,
                      ].filter(Boolean).join(' · ')
                      return (
                        <option key={v.id} value={v.id} disabled={blocked}>
                          {label}
                        </option>
                      )
                    })}
                  </select>

                  {/* Compliance banner */}
                  {selectedCompliance === 'hard_blocked' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5"
                         style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
                      <ShieldOff className="w-3.5 h-3.5 flex-shrink-0" />
                      This vendor has expired compliance documents (46+ days). Assignment is blocked.
                    </div>
                  )}
                  {selectedCompliance === 'grace_period' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      Compliance docs expired recently (grace period). You can assign but should follow up with the vendor.
                    </div>
                  )}
                  {selectedCompliance === 'expiring_soon' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      COI or license expires soon — assign now but remind vendor to renew.
                    </div>
                  )}
                  {selectedCompliance === 'no_documents' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      <Info className="w-3.5 h-3.5 flex-shrink-0" />
                      No compliance documents on file for this vendor.
                    </div>
                  )}

                  {selectedVendor && selectedCompliance !== 'hard_blocked' && (
                    <label className="flex items-center gap-2 text-sm text-secondary-themed cursor-pointer mt-2">
                      <input
                        type="checkbox"
                        name="portal_enabled"
                        defaultChecked
                        className="w-4 h-4 rounded border-themed text-brand-600 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                      />
                      Send vendor portal link (vendor can mark complete via link)
                    </label>
                  )}
                </>
              ) : (
                <div className="border border-themed rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-canvas-themed border-b border-themed">
                    <p className="text-xs text-muted-themed">
                      Select vendors to receive an RFQ — you&apos;ll be taken to the work order to review and approve quotes.
                    </p>
                  </div>
                  {vendors.map((v) => (
                    <label
                      key={v.id}
                      className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0 cursor-pointer hover:bg-canvas-themed transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedQuoteVendors.includes(v.id)}
                        onChange={() => toggleQuoteVendor(v.id)}
                        className="w-4 h-4 rounded border-themed text-brand-600 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                      />
                      <span className="flex-1 text-sm font-medium text-primary-themed">{v.name}</span>
                      <span className="text-xs text-muted-themed capitalize">{v.specialty.replace('_', ' ')}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
              </div>{/* /Assign To */}
            </div>{/* /right column */}
          </div>{/* /two-col grid */}

          {/* Photo attachments */}
          <div>
            <label className="label">Photos (optional)</label>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoSelect}
            />
            <div className="flex flex-wrap gap-2">
              {photoFiles.map((file, i) => (
                <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-themed">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(file)} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center"
                  >
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="w-16 h-16 rounded-lg border-2 border-dashed border-themed flex items-center justify-center transition-colors hover:border-brand-400"
                style={{ color: 'var(--text-muted)' }}
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>
          </div>

          </div>{/* /scrollable content */}

          <div className="flex gap-3 px-6 pb-6 pt-4 border-t border-themed flex-shrink-0">
            <Button
              type="submit"
              disabled={pending || selectedCompliance === 'hard_blocked'}
              className="flex-1"
            >
              {pending
                ? 'Creating…'
                : assignMode === 'quotes' && selectedQuoteVendors.length > 0
                ? `Create & Request ${selectedQuoteVendors.length} Quote${selectedQuoteVendors.length !== 1 ? 's' : ''}`
                : 'Create Work Order'}
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
    </Dialog>
  )
}
