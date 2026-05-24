'use client'

import { useActionState, useState } from 'react'
import { addMaintenanceSchedule, deleteMaintenanceSchedule, completeMaintenanceStep } from './actions'
import { Plus, Trash2, RefreshCw, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'

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
}: {
  propertyId: string
  schedules: Schedule[]
  vendors: { id: string; name: string; specialty: string }[]
}) {
  const addAction = addMaintenanceSchedule.bind(null, propertyId)
  const [state, formAction, pending] = useActionState(addAction, null)
  const [showForm, setShowForm] = useState(false)
  const [schedType, setSchedType] = useState<'routine' | 'seasonal'>('routine')
  const [completing, setCompleting] = useState(false)

  const prefill = (values: Partial<{ name: string; frequency: string; month_due: number }>) => {
    setShowForm(true)
  }

  return (
    <div className="space-y-6">
      {/* Existing schedules */}
      {schedules.length > 0 && (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3 bg-accent-50 rounded-lg border border-accent-100">
              <div className={cn('w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0',
                s.schedule_type === 'routine' ? 'bg-blue-100' : 'bg-amber-100'
              )}>
                {s.schedule_type === 'routine'
                  ? <RefreshCw className="w-3.5 h-3.5 text-blue-600" />
                  : <Calendar className="w-3.5 h-3.5 text-amber-600" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-accent-800">{s.name}</p>
                <p className="text-xs text-accent-400">
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
                <button type="submit" className="text-accent-300 hover:text-red-500 transition-colors p-1">
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
                  onClick={() => { setSchedType('routine'); setShowForm(true) }}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-accent-600 hover:bg-accent-100 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
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
                  onClick={() => { setSchedType('seasonal'); setShowForm(true) }}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-accent-600 hover:bg-accent-100 transition-colors"
                >
                  <Calendar className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="border border-accent-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-accent-700">Add Schedule</h3>

          {state?.error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{state.error}</div>
          )}

          <form action={async (fd) => {
            await formAction(fd)
            setShowForm(false)
          }} className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input name="name" type="text" className="input" placeholder="e.g. HVAC Filter Change" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Type</label>
                <div className="flex rounded-lg overflow-hidden border border-accent-200">
                  {(['routine', 'seasonal'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setSchedType(t)}
                      className={cn('flex-1 py-2 text-sm font-medium transition-colors capitalize',
                        schedType === t ? 'bg-brand-800 text-white' : 'bg-white text-accent-600 hover:bg-accent-50'
                      )}
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
                  <select name="frequency" className="input">
                    {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="label">Month Due</label>
                  <select name="month_due" className="input">
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
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
                <input type="checkbox" name="auto_create_wo" value="true" className="rounded border-accent-300 text-brand-700 focus:ring-brand-500" />
                <span className="text-sm text-accent-700">Auto-create work order when due</span>
              </label>
            </div>

            <div className="flex gap-3">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Adding…' : 'Add Schedule'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn-ghost text-sm">Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="btn-secondary w-full justify-center border-dashed">
          <Plus className="w-4 h-4" /> Add Schedule
        </button>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-accent-100">
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
