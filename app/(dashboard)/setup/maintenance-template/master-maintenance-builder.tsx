'use client'

import { useState, useTransition } from 'react'
import { Plus, X, Check } from 'lucide-react'
import { saveMasterMaintenanceSchedules, type MaintenanceScheduleInput } from './actions'

const VENDOR_SPECIALTIES = [
  'plumbing', 'electrical', 'hvac', 'landscaping', 'cleaning',
  'pest_control', 'pool', 'roofing', 'general', 'other',
] as const

const SPECIALTY_LABELS: Record<string, string> = {
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

const FREQUENCY_LABELS: Record<string, string> = {
  weekly:      'Weekly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  semi_annual: 'Semi-Annually',
  annually:    'Annually',
}

function emptySchedule(): MaintenanceScheduleInput {
  return { title: '', description: null, frequency: 'monthly', specialty: null, estimated_cost: null }
}

export function MasterMaintenanceBuilder({
  existingItems,
  suggestionItems = [],
  finishAction,
}: {
  existingItems:    Array<{ id: string; title: string; description: string | null; frequency: string; specialty: string | null; estimated_cost: number | null }>
  suggestionItems?: Array<{ title: string; description: string | null; frequency: string; specialty: string | null; estimated_cost: number | null }>
  finishAction:     () => Promise<void>
}) {
  const [schedules, setSchedules] = useState<MaintenanceScheduleInput[]>(
    existingItems.length > 0
      ? existingItems.map(({ title, description, frequency, specialty, estimated_cost }) => ({
          title, description, frequency, specialty, estimated_cost,
        }))
      : []
  )
  const [saving, startSave] = useTransition()
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const update = (i: number, patch: Partial<MaintenanceScheduleInput>) => {
    setSchedules((prev) => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }

  const remove = (i: number) => {
    setSchedules((prev) => prev.filter((_, idx) => idx !== i))
  }

  const handleSave = (andFinish = false) => {
    setError(null)
    const valid = schedules.filter((s) => s.title.trim())
    startSave(async () => {
      const result = await saveMasterMaintenanceSchedules(valid)
      if (result.error) {
        setError(result.error)
      } else {
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
        if (andFinish) await finishAction()
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* Quick-add suggestions */}
      {suggestionItems.length > 0 && (
        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wide"
               style={{ color: 'var(--text-muted)' }}>
              Suggested Schedules — tap to add
            </p>
            {suggestionItems.some((s) => !schedules.some((existing) => existing.title === s.title)) && (
              <button
                type="button"
                onClick={() => {
                  const toAdd = suggestionItems
                    .filter((s) => !schedules.some((existing) => existing.title === s.title))
                    .map((s) => ({ title: s.title, description: s.description, frequency: s.frequency, specialty: s.specialty, estimated_cost: s.estimated_cost }))
                  setSchedules((prev) => [...prev, ...toAdd])
                }}
                className="text-xs font-medium"
                style={{ color: 'var(--accent-gold)' }}
              >
                Add all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestionItems
              .filter((s) => !schedules.some((existing) => existing.title === s.title))
              .map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => setSchedules((prev) => [
                    ...prev,
                    { title: s.title, description: s.description, frequency: s.frequency, specialty: s.specialty, estimated_cost: s.estimated_cost },
                  ])}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
                  style={{
                    background: 'var(--bg-card)',
                    color:      'var(--text-secondary)',
                    border:     '1px solid var(--border)',
                  }}
                >
                  + {s.title}
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    ({FREQUENCY_LABELS[s.frequency] ?? s.frequency})
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}

      {schedules.map((s, i) => (
        <div key={i} className="card p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Title *</label>
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                    className="input"
                    placeholder="e.g. HVAC Filter Replacement"
                  />
                </div>
                <div>
                  <label className="label">Frequency</label>
                  <select
                    value={s.frequency}
                    onChange={(e) => update(i, { frequency: e.target.value })}
                    className="input"
                  >
                    {Object.entries(FREQUENCY_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Specialty</label>
                  <select
                    value={s.specialty ?? ''}
                    onChange={(e) => update(i, { specialty: e.target.value || null })}
                    className="input"
                  >
                    <option value="">— Any —</option>
                    {VENDOR_SPECIALTIES.map((sp) => (
                      <option key={sp} value={sp}>{SPECIALTY_LABELS[sp]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Est. Cost (optional)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={s.estimated_cost ?? ''}
                    onChange={(e) => update(i, { estimated_cost: e.target.value ? parseFloat(e.target.value) : null })}
                    className="input"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div>
                <label className="label">Description (optional)</label>
                <textarea
                  value={s.description ?? ''}
                  onChange={(e) => update(i, { description: e.target.value || null })}
                  rows={2}
                  className="input resize-none text-sm"
                  placeholder="Any additional notes or instructions…"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => remove(i)}
              className="flex-shrink-0 p-1.5 rounded-lg transition-colors mt-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setSchedules((prev) => [...prev, emptySchedule()])}
        className="btn-secondary text-sm flex items-center gap-2 w-full justify-center"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Another
      </button>

      {error && (
        <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      <div className="flex items-center gap-3 pt-2 border-t border-themed">
        <button
          type="button"
          onClick={() => handleSave(true)}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save & Finish'}
        </button>
        <button
          type="button"
          onClick={() => handleSave(false)}
          disabled={saving}
          className="btn-secondary"
        >
          Save
        </button>
        {success && (
          <span className="text-sm flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
      </div>
    </div>
  )
}
