'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { broadcastMaintenanceTemplate } from '@/app/(dashboard)/maintenance/actions'
import type { MaintenanceScheduleTemplateItem, ScheduleFrequency } from '@/types/database'
import { RECURRENCE_LABELS, MONTH_NAMES } from '@/types/database'
import { Loader2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

const STANDARD_TEMPLATE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

interface Props {
  propertyId: string
  onComplete: () => void
  onClose:    () => void
}

export function StandardTemplateModal({ propertyId, onComplete, onClose }: Readonly<Props>) {
  const supabase = createClient()

  const [items,       setItems]       = useState<MaintenanceScheduleTemplateItem[]>([])
  const [recurrences, setRecurrences] = useState<Record<string, ScheduleFrequency>>({})
  const [dueDates,    setDueDates]    = useState<Record<string, string>>({})
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  useEffect(() => {
    async function loadTemplate() {
      setLoading(true)

      const { data, error: err } = await supabase
        .from('maintenance_schedule_template_items')
        .select('*')
        .eq('template_id', STANDARD_TEMPLATE_ID)
        .order('sort_order')

      if (err || !data) {
        setLoading(false)
        return
      }

      const typedData = data as MaintenanceScheduleTemplateItem[]
      setItems(typedData)

      const today = new Date().toISOString().split('T')[0]
      const defaultDates:  Record<string, string>            = {}
      const defaultRecur:  Record<string, ScheduleFrequency> = {}

      typedData.forEach((item) => {
        defaultDates[item.id] = today
        defaultRecur[item.id] = (item.schedule_frequency as ScheduleFrequency) ?? 'annual'
      })

      setDueDates(defaultDates)
      setRecurrences(defaultRecur)
      setLoading(false)
    }

    loadTemplate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleApply() {
    setSaving(true)
    setError(null)

    const result = await broadcastMaintenanceTemplate(
      STANDARD_TEMPLATE_ID,
      [propertyId],
      dueDates,
      recurrences,
    )

    setSaving(false)

    if (result.error) {
      setError('Failed to apply template. Please try again.')
      return
    }

    onComplete()
  }

  return (
    <Dialog open onClose={onClose} title="Standard Maintenance Template" mobileSheet>
      <div className="flex flex-col max-h-[75vh] -m-6">
        {/* Sub-header */}
        <p className="text-xs text-muted-themed px-5 pt-1 pb-3 border-b border-themed shrink-0">
          Adjust frequencies and start dates below
        </p>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-themed flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading template…
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl p-3 space-y-2 border border-themed"
                style={{ background: 'var(--bg-raised)' }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-primary-themed">{item.name}</span>
                  {item.active_from_month !== null && item.active_to_month !== null && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }}>
                      {MONTH_NAMES[item.active_from_month]}–{MONTH_NAMES[item.active_to_month]}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={recurrences[item.id] ?? 'annual'}
                    onChange={(e) => setRecurrences((prev) => ({
                      ...prev,
                      [item.id]: e.target.value as ScheduleFrequency,
                    }))}
                    className="flex-1 input py-1.5 text-xs"
                  >
                    {(Object.entries(RECURRENCE_LABELS) as [ScheduleFrequency, string][]).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>

                  <input
                    type="date"
                    value={dueDates[item.id] ?? ''}
                    onChange={(e) => setDueDates((prev) => ({
                      ...prev,
                      [item.id]: e.target.value,
                    }))}
                    className="flex-1 input py-1.5 text-xs"
                  />
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-4 border-t border-themed shrink-0 space-y-2">
          {error && (
            <p className="text-xs text-center" style={{ color: 'var(--accent-red)' }}>{error}</p>
          )}
          <Button
            onClick={handleApply}
            disabled={saving || loading}
            className="w-full py-3"
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</> : 'Apply to Property'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
