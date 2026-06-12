'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { addMaintenanceSchedule, deleteMaintenanceSchedule, completeMaintenanceStep, cloneMaintenanceFromProperty } from './actions'
import { Plus, Trash2, RefreshCw, Calendar } from 'lucide-react'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FREQUENCIES = [
  { value: 'weekly',      label: 'Weekly' },
  { value: 'biweekly',    label: 'Every 2 Weeks' },
  { value: 'monthly',     label: 'Monthly' },
  { value: 'quarterly',   label: 'Quarterly' },
  { value: 'semi_annual', label: 'Twice a Year' },
  { value: 'annual',      label: 'Annually' },
]

const ROUTINE_SUGGESTIONS = [
  { name: 'HVAC Filter Change', frequency: 'quarterly', cost: '' },
  { name: 'Pest Control', frequency: 'quarterly', cost: '' },
  { name: 'Lawn Mowing', frequency: 'biweekly', cost: '' },
  { name: 'Gutter Cleaning', frequency: 'semi_annual', cost: '' },
  { name: 'Smoke Detector Test', frequency: 'annual', cost: '' },
]

const SEASONAL_SUGGESTIONS = [
  { name: 'Dock Installation', month: 4 },
  { name: 'Dock Removal', month: 11 },
  { name: 'Pool Opening', month: 5 },
  { name: 'Pool Closing', month: 10 },
  { name: 'Winterization', month: 11 },
  { name: 'Spring Deep Clean', month: 3 },
]

interface Schedule {
  id: string
  name: string
  schedule_type: string
  frequency: string | null
  month_due: number | null
  estimated_cost: number | null
  auto_create_wo: boolean
  vendors?: { name: string } | null
}

export function MaintenanceScheduleManager({
  propertyId,
  schedules,
  vendors,
  sourceProperties = [],
}: {
  propertyId: string
  schedules: Schedule[]
  vendors: { id: string; name: string; specialty: string }[]
  sourceProperties?: { id: string; name: string; scheduleCount: number }[]
}) {
  const addAction = addMaintenanceSchedule.bind(null, propertyId)
  const [state, formAction, pending] = useActionState(addAction, null)
  const [showForm, setShowForm] = useState(false)
  const [schedType, setSchedType] = useState<'routine' | 'seasonal'>('routine')
  const [completing, setCompleting] = useState(false)
  const [prefilledName, setPrefilledName]           = useState('')
  const [prefilledFrequency, setPrefilledFrequency] = useState('quarterly')
  const [prefilledMonth, setPrefilledMonth]         = useState<number | ''>('')
  const [cloneModal, setCloneModal] = useState(false)
  const [cloneSource, setCloneSource] = useState('')
  const [cloning, startClone] = useTransition()
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneSuccess, setCloneSuccess] = useState<string | null>(null)

  const prefill = (values: Partial<{ name: string; frequency: string; month_due: number }>) => {
    setPrefilledName(values.name ?? '')
    setPrefilledFrequency(values.frequency ?? 'quarterly')
    setPrefilledMonth(values.month_due ?? '')
    setSchedType(values.month_due !== undefined ? 'seasonal' : 'routine')
    setShowForm(true)
  }

  const resetPrefill = () => {
    setPrefilledName('')
    setPrefilledFrequency('quarterly')
    setPrefilledMonth('')
  }

  // Close form on successful submission only
  useEffect(() => {
    if (state?.success) {
      resetPrefill()
      setShowForm(false)
    }
  }, [state?.success])

  const handleClone = () => {
    if (!cloneSource) return
    startClone(async () => {
      const res = await cloneMaintenanceFromProperty(cloneSource, propertyId)
      if (res.error) { setCloneError(res.error); return }
      setCloneModal(false)
      setCloneSuccess(`${res.added} schedules added, dates reset to unscheduled`)
      setTimeout(() => window.location.reload(), 1200)
    })
  }

  return (
    <div className="space-y-6" suppressHydrationWarning>
      {cloneSuccess && (
        <div className="rounded-lg px-4 py-3 text-sm flex items-center gap-2"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}>
          &#10003; {cloneSuccess}
        </div>
      )}

      {/* Clone from another property */}
      {schedules.length === 0 && sourceProperties.length > 0 && (
        <div
          className="rounded-xl px-4 py-4 flex items-center justify-between gap-4"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <div>
            <p className="text-sm font-semibold text-primary-themed">Copy from another property</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Duplicate maintenance schedules from an existing property. Due dates start fresh.
            </p>
          </div>
          <button onClick={() => setCloneModal(true)} className="btn-secondary text-xs whitespace-nowrap">
            Clone Schedules
          </button>
        </div>
      )}

      {cloneModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-sm p-6">
            <h3 className="font-semibold text-primary-themed mb-1">Clone Schedules From</h3>
            <p className="text-xs text-muted-themed mb-4">
              Schedules already on this property will be skipped. Due dates are reset to unscheduled.
            </p>
            {cloneError && (
              <div className="border text-sm rounded-lg px-3 py-2 mb-3" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{cloneError}</div>
            )}
            <select
              value={cloneSource}
              onChange={e => setCloneSource(e.target.value)}
              className="input w-full mb-4"
            >
              <option value="">Select a property…</option>
              {sourceProperties.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.scheduleCount} schedules)
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={handleClone}
                disabled={!cloneSource || cloning}
                className="btn-primary flex-1"
              >
                {cloning ? 'Cloning…' : 'Clone Schedules'}
              </button>
              <button onClick={() => setCloneModal(false)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Existing schedules */}
      {schedules.length > 0 && (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3 bg-canvas-themed rounded-lg border border-themed">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: s.schedule_type === 'routine' ? 'var(--accent-blue-dim)' : 'var(--accent-amber-dim)' }}
              >
                {s.schedule_type === 'routine'
                  ? <RefreshCw className="w-3.5 h-3.5" style={{ color: 'var(--accent-blue)' }} />
                  : <Calendar className="w-3.5 h-3.5" style={{ color: 'var(--accent-amber)' }} />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-primary-themed">{s.name}</p>
                <p className="text-xs text-muted-themed">
                  {s.schedule_type === 'routine'
                    ? FREQUENCIES.find((f) => f.value === s.frequency)?.label ?? s.frequency
                    : `Every ${MONTHS[(s.month_due ?? 1) - 1]}`
                  }
                  {s.estimated_cost ? ` · ~$${s.estimated_cost}` : ''}
                  {s.vendors ? ` · ${s.vendors.name}` : ''}
                  {s.auto_create_wo ? ' · Auto WO' : ''}
                </p>
              </div>
              <form action={async () => { await deleteMaintenanceSchedule(s.id, propertyId) }}>
                <button type="submit" className="text-muted-themed hover:text-red-500 transition-colors p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      {/* Quick add suggestions */}
      {!showForm && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="section-header">Routine Suggestions</p>
            <div className="space-y-1.5">
              {ROUTINE_SUGGESTIONS.map((s) => (
                <button
                  key={s.name}
                  onClick={() => prefill({ name: s.name, frequency: s.frequency })}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-secondary-themed hover:bg-raised-themed transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-blue)' }} />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="section-header">Seasonal Suggestions</p>
            <div className="space-y-1.5">
              {SEASONAL_SUGGESTIONS.map((s) => (
                <button
                  key={s.name}
                  onClick={() => prefill({ name: s.name, month_due: s.month })}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-secondary-themed hover:bg-raised-themed transition-colors"
                >
                  <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-amber)' }} />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="border border-themed rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-primary-themed">Add Schedule</h3>

          {state?.error && (
            <div className="border text-sm rounded-lg px-3 py-2" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{state.error}</div>
          )}

          <form action={formAction} className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input
                name="name"
                type="text"
                required
                className="input"
                value={prefilledName}
                onChange={(e) => setPrefilledName(e.target.value)}
                placeholder="e.g. HVAC Filter Change"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Type</label>
                <div className="flex rounded-lg overflow-hidden border border-themed">
                  {(['routine', 'seasonal'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setSchedType(t)}
                      className="flex-1 py-2 text-sm font-medium transition-colors capitalize"
                      style={
                        schedType === t
                          ? { background: 'var(--accent-gold)', color: 'var(--bg-card)' }
                          : { background: 'var(--bg-card)', color: 'var(--text-secondary)' }
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <input type="hidden" name="schedule_type" value={schedType} />
              </div>

              {schedType === 'routine' ? (
                <div>
                  <label className="label">Frequency</label>
                  <select
                    name="frequency"
                    className="input"
                    value={prefilledFrequency}
                    onChange={(e) => setPrefilledFrequency(e.target.value)}
                  >
                    {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="label">Month Due</label>
                  <select
                    name="month_due"
                    className="input"
                    value={prefilledMonth}
                    onChange={(e) => setPrefilledMonth(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">Select month…</option>
                    {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Est. Cost ($)</label>
                <input name="estimated_cost" type="number" min="0" step="0.01" className="input" placeholder="0.00" />
              </div>
              {vendors.length > 0 && (
                <div>
                  <label className="label">Assign Vendor</label>
                  <select name="vendor_id" className="input">
                    <option value="">None</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div>
              <label className="label">Instructions</label>
              <textarea name="instructions" rows={2} className="input resize-none" placeholder="Details for whoever handles this…" />
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="auto_create_wo"
                  value="true"
                  defaultChecked
                  className="rounded border-themed"
                  style={{ accentColor: 'var(--accent-gold)' }}
                />
                <span className="text-sm text-primary-themed">Auto-create work order when due</span>
              </label>
            </div>

            <div className="flex gap-3">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Adding…' : 'Add Schedule'}
              </button>
              <button type="button" onClick={() => { resetPrefill(); setShowForm(false) }} className="btn-ghost text-sm">Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="btn-secondary w-full justify-center border-dashed">
          <Plus className="w-4 h-4" /> Add Schedule
        </button>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-themed">
        <form action={async () => {
          setCompleting(true)
          await completeMaintenanceStep(propertyId)
        }}>
          <button type="submit" disabled={completing} className="btn-primary">
            {completing ? 'Saving…' : schedules.length > 0 ? 'Save & Continue →' : 'Skip for now →'}
          </button>
        </form>
      </div>
    </div>
  )
}
