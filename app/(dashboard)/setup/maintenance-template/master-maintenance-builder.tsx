'use client'

import { useState, useTransition } from 'react'
import { Plus, X, Check } from 'lucide-react'
import { saveMasterMaintenanceSchedules, type MaintenanceScheduleInput } from './actions'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

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
  const [success, setSuccess]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set())

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

  const selectableSuggestions = suggestionItems.filter(
    (s) => !schedules.some((e) => e.title === s.title)
  )

  return (
    <div className="space-y-4">
      {/* Suggested Schedules — checkbox list */}
      {suggestionItems.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {/* Select-all header */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-themed"
               style={{ background: 'var(--bg-raised)' }}>
            <input
              type="checkbox"
              checked={selectableSuggestions.length > 0 && selectableSuggestions.every((s) => selectedSuggestions.has(s.title))}
              onChange={() => {
                const allSelected = selectableSuggestions.every((s) => selectedSuggestions.has(s.title))
                setSelectedSuggestions((prev) => {
                  const next = new Set(prev)
                  if (allSelected) {
                    selectableSuggestions.forEach((s) => next.delete(s.title))
                  } else {
                    selectableSuggestions.forEach((s) => next.add(s.title))
                  }
                  return next
                })
              }}
              className="w-4 h-4 rounded"
            />
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Select all ({selectableSuggestions.length})
            </span>
          </div>

          {/* Scrollable rows */}
          <div className="max-h-[28rem] overflow-y-auto">
            {suggestionItems.map((s) => {
              const alreadyAdded = schedules.some((e) => e.title === s.title)
              const isSelected   = selectedSuggestions.has(s.title)
              return (
                <div
                  key={s.title}
                  className={`flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0 transition-colors${alreadyAdded ? ' opacity-40' : ' cursor-pointer'}`}
                  style={isSelected && !alreadyAdded ? { background: 'var(--accent-gold-dim)' } : {}}
                  role={alreadyAdded ? undefined : 'button'}
                  tabIndex={alreadyAdded ? undefined : 0}
                  onClick={() => {
                    if (alreadyAdded) return
                    setSelectedSuggestions((prev) => {
                      const next = new Set(prev)
                      if (next.has(s.title)) { next.delete(s.title) } else { next.add(s.title) }
                      return next
                    })
                  }}
                  onKeyDown={alreadyAdded ? undefined : (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedSuggestions((prev) => {
                        const next = new Set(prev)
                        if (next.has(s.title)) { next.delete(s.title) } else { next.add(s.title) }
                        return next
                      })
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected || alreadyAdded}
                    readOnly
                    disabled={alreadyAdded}
                    className="w-4 h-4 rounded flex-shrink-0"
                  />
                  <span className="flex-1 text-sm font-medium text-primary-themed">{s.title}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {FREQUENCY_LABELS[s.frequency] ?? s.frequency}
                  </span>
                  {alreadyAdded && (
                    <span className="text-xs italic ml-1" style={{ color: 'var(--text-muted)' }}>added</span>
                  )}
                </div>
              )
            })}
          </div>

          {/* Batch-add button */}
          {selectedSuggestions.size > 0 && (
            <div className="px-4 py-3 border-t border-themed" style={{ background: 'var(--bg-raised)' }}>
              <Button
                type="button"
                onClick={() => {
                  const toAdd = suggestionItems
                    .filter((s) => selectedSuggestions.has(s.title) && !schedules.some((e) => e.title === s.title))
                    .map((s) => ({ title: s.title, description: s.description, frequency: s.frequency, specialty: s.specialty, estimated_cost: s.estimated_cost }))
                  setSchedules((prev) => [...prev, ...toAdd])
                  setSelectedSuggestions(new Set())
                }}
                className="text-sm w-full"
              >
                Add {selectedSuggestions.size} schedule{selectedSuggestions.size !== 1 ? 's' : ''}
              </Button>
            </div>
          )}
        </div>
      )}

      {schedules.map((s, i) => (
        <Card key={i} className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Title *</label>
                  <Input
                    type="text"
                    value={s.title}
                    onChange={(e) => update(i, { title: e.target.value })}
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
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={s.estimated_cost ?? ''}
                    onChange={(e) => update(i, { estimated_cost: e.target.value ? parseFloat(e.target.value) : null })}
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
        </Card>
      ))}

      <Button
        type="button"
        variant="secondary"
        onClick={() => setSchedules((prev) => [...prev, emptySchedule()])}
        className="text-sm flex items-center gap-2 w-full justify-center"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Another
      </Button>

      {error && (
        <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      <div className="flex items-center gap-3 pt-2 border-t border-themed">
        <Button
          type="button"
          onClick={() => handleSave(true)}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save & Finish'}
        </Button>
        <Button
          type="button"
          onClick={() => handleSave(false)}
          disabled={saving}
          variant="secondary"
        >
          Save
        </Button>
        {success && (
          <span className="text-sm flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
      </div>
    </div>
  )
}
