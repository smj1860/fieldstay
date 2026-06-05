'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter }            from 'next/navigation'
import { useState, useRef }                from 'react'
import {
  ArrowLeft, Camera, CheckCircle2, Circle,
  Loader2, ImageIcon, AlertCircle, AlertTriangle, X,
  Minus, Plus, MapPin,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient }       from '@/lib/supabase/client'

type TurnoverRow   = { id: string; status: string; priority: string; checkout_datetime: string; checkin_datetime: string; window_minutes: number; notes: string | null; property_id: string; org_id: string }
type InstanceRow   = { id: string; turnover_id: string; status: string }
type ChecklistItem = { id: string; instance_id: string; section_name: string; task: string; notes: string | null; is_completed: number; requires_photo: number; photo_storage_path: string | null; crew_notes: string | null; sort_order: number }
type InvRow        = { id: string; name: string; category: string; unit: string; par_level: number; current_quantity: number; property_id: string }
type PropertyRow   = { id: string; name: string; address: string | null; city: string | null; state: string | null }

export default function CrewTurnoverPage() {
  const { id }   = useParams<{ id: string }>()
  const router   = useRouter()
  const db       = usePowerSync()
  const supabase = createClient()

  const [uploadingItemId,   setUploadingItemId]   = useState<string | null>(null)
  const [uploadError,       setUploadError]       = useState<string | null>(null)
  const [completing,        setCompleting]        = useState(false)
  const [showFlagModal,     setShowFlagModal]     = useState(false)
  const [counts,            setCounts]            = useState<Record<string, number>>({})
  const [sectionPhotoPrompt, setSectionPhotoPrompt] = useState<string | null>(null)
  const fileInputRefs      = useRef<Record<string, HTMLInputElement | null>>({})
  const sectionPhotoRefs   = useRef<Record<string, HTMLInputElement | null>>({})

  const turnovers      = usePowerSyncQuery<TurnoverRow>('SELECT * FROM turnovers WHERE id = ?', [id])
  const turnover       = turnovers?.[0]

  const propertiesRaw  = usePowerSyncQuery<PropertyRow>(
    'SELECT * FROM properties WHERE id = ?',
    [turnover?.property_id ?? '']
  )
  const property = propertiesRaw?.[0] ?? null

  const instances = usePowerSyncQuery<InstanceRow>('SELECT * FROM checklist_instances WHERE turnover_id = ?', [id])
  const instance  = instances?.[0]

  const items = usePowerSyncQuery<ChecklistItem>(
    `SELECT * FROM checklist_instance_items WHERE instance_id = ? ORDER BY section_name, sort_order`,
    [instance?.id ?? '']
  )

  const inventoryItems = usePowerSyncQuery<InvRow>(
    `SELECT * FROM inventory_items WHERE property_id = ? ORDER BY category, name`,
    [turnover?.property_id ?? '']
  )

  const completedCount = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount     = items?.length ?? 0
  const pendingPhotos  = items?.filter((i) => i.requires_photo && !i.photo_storage_path) ?? []

  const sections = (items ?? []).reduce<Record<string, ChecklistItem[]>>(
    (acc, item) => {
      if (!acc[item.section_name]) acc[item.section_name] = []
      acc[item.section_name]!.push(item)
      return acc
    },
    {}
  )

  // Group inventory by category
  const invByCategory = (inventoryItems ?? []).reduce<Record<string, InvRow[]>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = []
      acc[item.category]!.push(item)
      return acc
    },
    {}
  )

  const toggleItem = async (itemId: string, current: number, requiresPhoto: number, photoPath: string | null, sectionName: string) => {
    if (!current && requiresPhoto && !photoPath) {
      fileInputRefs.current[itemId]?.click()
      return
    }
    await db.execute(
      'UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?',
      [current ? 0 : 1, itemId]
    )
    // Check if section is now fully complete
    if (!current) {
      const sectionItems = sections[sectionName] ?? []
      const allComplete = sectionItems.every(i => (i.id === itemId ? 1 : i.is_completed))
      if (allComplete && sectionItems.length > 0) {
        setSectionPhotoPrompt(sectionName)
      }
    }
  }

  const handleSectionPhoto = async (sectionName: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const ext  = file.name.split('.').pop() ?? 'jpg'
    const path = `turnover-${id}/section-${sectionName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.${ext}`
    await supabase.storage
      .from('turnover-photos')
      .upload(path, file, { contentType: file.type, upsert: true })
    setSectionPhotoPrompt(null)
    e.target.value = ''
  }

  const handlePhotoCapture = async (itemId: string, file: File) => {
    setUploadingItemId(itemId)
    setUploadError(null)
    try {
      const ext  = file.name.split('.').pop() ?? 'jpg'
      const path = `turnover-${id}/${itemId}-${Date.now()}.${ext}`
      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(path, file, { contentType: file.type, upsert: true })
      if (error) throw new Error(error.message)
      await db.execute(
        `UPDATE checklist_instance_items SET photo_storage_path = ?, is_completed = 1 WHERE id = ?`,
        [path, itemId]
      )
    } catch (err) {
      console.error('Photo upload failed:', err)
      setUploadError('Photo upload failed. Make sure you have a connection and try again.')
    } finally {
      setUploadingItemId(null)
    }
  }

  const handleCountChange = async (itemId: string, newQty: number) => {
    const qty = Math.max(0, newQty)
    setCounts((prev) => ({ ...prev, [itemId]: qty }))
    await db.execute(
      'UPDATE inventory_items SET current_quantity = ? WHERE id = ?',
      [qty, itemId]
    )
  }

  const getCount = (item: InvRow) =>
    counts[item.id] !== undefined ? counts[item.id] : item.current_quantity

  const markInProgress = async () => {
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['in_progress', id])
  }

  const markComplete = async () => {
    if (pendingPhotos.length > 0) {
      const ok = confirm(
        `${pendingPhotos.length} item${pendingPhotos.length !== 1 ? 's' : ''} still need photos. Mark complete anyway?`
      )
      if (!ok) return
    }
    setCompleting(true)
    await db.execute('UPDATE turnovers SET status = ? WHERE id = ?', ['completed', id])
    router.push('/crew')
  }

  if (!turnover) {
    return (
      <div className="text-center py-20 text-accent-400">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  const fullAddress = [property?.address, property?.city, property?.state].filter(Boolean).join(', ')

  return (
    <div>
      {/* Back button — icon only */}
      <button
        onClick={() => router.push('/crew')}
        className="flex items-center justify-center w-8 h-8 rounded-lg text-accent-400 hover:text-accent-700 hover:bg-accent-100 transition-colors mb-4"
        aria-label="Back to assignments"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      {/* Property info card */}
      <div className="bg-white rounded-xl border border-accent-200 p-4 mb-4">
        <p className="font-bold text-accent-900 text-lg leading-tight">
          {property?.name ?? 'Loading property…'}
        </p>
        {fullAddress && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(fullAddress)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-700 flex items-center gap-1 mt-1 hover:underline"
          >
            <MapPin className="w-3 h-3 flex-shrink-0" />
            {fullAddress}
          </a>
        )}

        <div className="mt-3 pt-3 border-t border-accent-100 flex items-center justify-between flex-wrap gap-2">
          <span className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            turnover.priority === 'urgent' ? 'bg-red-50 text-red-600' :
            turnover.priority === 'high'   ? 'bg-amber-50 text-amber-700' :
            'bg-accent-100 text-accent-600'
          )}>
            {turnover.priority} priority
          </span>
          {turnover.window_minutes && (
            <span className="text-sm font-semibold text-accent-600">
              {Math.floor(turnover.window_minutes / 60)}h
              {turnover.window_minutes % 60 > 0 ? ` ${turnover.window_minutes % 60}m` : ''} window
            </span>
          )}
        </div>

        <div className="mt-2 space-y-1 text-sm">
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Checkout</span>
            <span className="font-medium text-accent-900">{formatDateTime(turnover.checkout_datetime)}</span>
          </div>
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-accent-900">{formatDateTime(turnover.checkin_datetime)}</span>
          </div>
        </div>

        {turnover.notes && (
          <p className="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
            📝 {turnover.notes}
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{uploadError}</p>
        </div>
      )}

      {/* Checklist section */}
      {totalCount > 0 && (
        <>
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold text-accent-700">
                Checklist — {completedCount} of {totalCount}
              </span>
              <span className="text-sm text-accent-400">
                {Math.round((completedCount / totalCount) * 100)}%
              </span>
            </div>
            <div className="h-2 bg-accent-200 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-300',
                  completedCount === totalCount ? 'bg-green-500' : 'bg-brand-800'
                )}
                style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
              />
            </div>
            {pendingPhotos.length > 0 && (
              <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                <Camera className="w-3 h-3" />
                {pendingPhotos.length} item{pendingPhotos.length !== 1 ? 's' : ''} still
                need{pendingPhotos.length === 1 ? 's' : ''} a photo
              </p>
            )}
          </div>

          {Object.entries(sections).map(([sectionName, sectionItems]) => (
            <div key={sectionName} className="mb-4">
              <h3 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2 px-1">
                {sectionName}
              </h3>
              <div className="bg-white rounded-xl border border-accent-200 divide-y divide-accent-100 overflow-hidden">
                {sectionItems.map((item: ChecklistItem) => {
                  const needsPhoto = item.requires_photo && !item.photo_storage_path
                  const uploading  = uploadingItemId === item.id

                  return (
                    <div key={item.id} className={cn('flex items-start gap-3 px-4 py-3', item.is_completed ? 'bg-green-50' : 'bg-white')}>
                      <button
                        className="flex-shrink-0 mt-0.5"
                        onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                      >
                        {item.is_completed
                          ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                          : <Circle className={cn('w-5 h-5', needsPhoto ? 'text-amber-400' : 'text-accent-300')} />}
                      </button>

                      <div className="flex-1 min-w-0">
                        <p className={cn('text-sm leading-snug',
                          item.is_completed ? 'text-green-700 line-through' : 'text-accent-800')}>
                          {item.task}
                        </p>
                        {item.notes && <p className="text-xs text-accent-400 mt-0.5">{item.notes}</p>}
                        {item.photo_storage_path && (
                          <p className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                            <ImageIcon className="w-3 h-3" /> Photo attached
                          </p>
                        )}
                        {needsPhoto && !uploading && (
                          <p className="text-xs text-amber-600 mt-0.5">Photo required before completing</p>
                        )}
                      </div>

                      {item.requires_photo && (
                        <div className="flex-shrink-0">
                          {uploading ? (
                            <div className="p-1.5"><Loader2 className="w-4 h-4 text-accent-400 animate-spin" /></div>
                          ) : (
                            <button
                              onClick={() => fileInputRefs.current[item.id]?.click()}
                              className={cn('p-1.5 rounded-lg transition-colors',
                                item.photo_storage_path
                                  ? 'text-green-600 bg-green-50 hover:bg-green-100'
                                  : 'text-amber-600 bg-amber-50 hover:bg-amber-100'
                              )}
                              title={item.photo_storage_path ? 'Replace photo' : 'Tap to take required photo'}
                            >
                              <Camera className="w-4 h-4" />
                            </button>
                          )}
                          <input
                            ref={(el) => { fileInputRefs.current[item.id] = el }}
                            type="file" accept="image/*" capture="environment" className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) handlePhotoCapture(item.id, file)
                              e.target.value = ''
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Section-complete photo prompt */}
              {sectionPhotoPrompt === sectionName && (
                <div
                  className="flex items-center gap-3 mt-2 p-3 rounded-xl border-2 border-dashed"
                  style={{ borderColor: '#FCD116', background: 'rgba(252,209,22,0.08)' }}
                >
                  <Camera className="w-5 h-5 flex-shrink-0" style={{ color: '#B8961A' }} />
                  <div className="flex-1 text-sm font-medium" style={{ color: '#B8961A' }}>
                    Section complete — add a final photo
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    ref={r => { sectionPhotoRefs.current[sectionName] = r }}
                    onChange={e => handleSectionPhoto(sectionName, e)}
                  />
                  <button
                    onClick={() => sectionPhotoRefs.current[sectionName]?.click()}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#FCD116', color: '#1a1a1a' }}
                  >
                    Take Photo
                  </button>
                  <button
                    onClick={() => setSectionPhotoPrompt(null)}
                    className="text-xs px-2 py-1.5 rounded-lg text-accent-500 hover:bg-accent-100"
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {totalCount === 0 && (
        <div className="bg-white rounded-xl border border-accent-200 p-6 text-center text-accent-400 text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      {/* Inventory section */}
      {inventoryItems && inventoryItems.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-accent-500 uppercase tracking-wide mb-2 px-1">
            Inventory
          </h3>
          <div className="space-y-3">
            {Object.entries(invByCategory).map(([category, catItems]) => (
              <div key={category}>
                <p className="text-xs text-accent-400 font-medium uppercase tracking-wide mb-1.5 px-1">
                  {category.replace(/_/g, ' ')}
                </p>
                <div className="bg-white rounded-xl border border-accent-200 divide-y divide-accent-100 overflow-hidden">
                  {catItems.map((item) => {
                    const qty    = getCount(item)
                    const isLow  = qty < item.par_level
                    return (
                      <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-accent-800 truncate">{item.name}</p>
                          <p className="text-xs text-accent-400">
                            Par {item.par_level} {item.unit}
                            {isLow && (
                              <span className="ml-1.5 text-amber-600 font-medium">· Low</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleCountChange(item.id, qty - 1)}
                            className="w-7 h-7 rounded-lg border border-accent-200 flex items-center justify-center text-accent-500 hover:bg-accent-100 active:bg-accent-200 transition-colors"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <input
                            type="number"
                            min={0}
                            value={qty}
                            onChange={(e) => handleCountChange(item.id, parseInt(e.target.value, 10) || 0)}
                            className="w-12 text-center text-sm font-semibold text-accent-900 border border-accent-200 rounded-lg py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                          />
                          <button
                            onClick={() => handleCountChange(item.id, qty + 1)}
                            className="w-7 h-7 rounded-lg border border-accent-200 flex items-center justify-center text-accent-500 hover:bg-accent-100 active:bg-accent-200 transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-accent-400 text-center mt-2">Inventory updates save automatically</p>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3 pb-8 mt-4">
        <button
          onClick={() => setShowFlagModal(true)}
          className="w-full py-3 rounded-xl text-sm font-medium flex items-center justify-center gap-2 border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
        >
          <AlertTriangle className="w-4 h-4" />
          Report an Issue
        </button>

        {turnover.status === 'assigned' && (
          <button onClick={markInProgress} className="btn-secondary w-full py-3">
            Start Turnover
          </button>
        )}
        <button
          onClick={markComplete}
          disabled={completing || turnover.status === 'completed'}
          className="btn-cta w-full py-3 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {completing
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            : turnover.status === 'completed'
            ? '✓ Marked Complete'
            : 'Mark as Complete'
          }
        </button>
      </div>

      {showFlagModal && (
        <IssueReportModal
          turnover={turnover}
          supabase={supabase}
          onClose={() => setShowFlagModal(false)}
        />
      )}
    </div>
  )
}

// ── Issue Report Modal (unchanged) ────────────────────────────────────────────

function IssueReportModal({
  turnover,
  supabase,
  onClose,
}: {
  turnover: { id: string; property_id: string; org_id: string }
  supabase: ReturnType<typeof createClient>
  onClose: () => void
}) {
  const [title,      setTitle]      = useState('')
  const [details,    setDetails]    = useState('')
  const [priority,   setPriority]   = useState<'medium' | 'high' | 'urgent'>('medium')
  const [submitting, setSubmitting] = useState(false)
  const [success,    setSuccess]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setError('Please describe the issue.'); return }
    setSubmitting(true)
    setError(null)

    try {
      const { error: insertErr } = await supabase.from('work_orders').insert({
        property_id: turnover.property_id,
        org_id:      turnover.org_id,
        title:       title.trim(),
        description: details.trim() || null,
        priority,
        status:      'pending',
        source:      'crew_flag',
      })
      if (insertErr) throw new Error(insertErr.message)
      setSuccess(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
        {success ? (
          <div className="text-center py-4">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <h3 className="font-semibold text-accent-900 mb-1">Issue Reported</h3>
            <p className="text-sm text-accent-500 mb-4">
              The property manager will be notified and a work order has been created.
            </p>
            <button onClick={onClose} className="btn-primary w-full">Done</button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-accent-900 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Report an Issue
              </h3>
              <button onClick={onClose} className="text-accent-400 hover:text-accent-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="label">What's the issue? *</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="input"
                  placeholder="e.g. Leaking faucet in master bath"
                  required
                />
              </div>
              <div>
                <label className="label">Details (optional)</label>
                <textarea
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={2}
                  className="input resize-none"
                  placeholder="Location, severity, anything else the PM should know…"
                />
              </div>
              <div>
                <label className="label">Urgency</label>
                <div className="flex gap-2">
                  {(['medium', 'high', 'urgent'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={cn(
                        'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize',
                        priority === p
                          ? p === 'urgent' ? 'bg-red-500 text-white border-red-500'
                            : p === 'high' ? 'bg-amber-500 text-white border-amber-500'
                            : 'bg-blue-500 text-white border-blue-500'
                          : 'bg-white text-accent-600 border-accent-300 hover:border-accent-400'
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {submitting
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
                  : <><AlertTriangle className="w-4 h-4" /> Submit Report</>
                }
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
