'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { addCatalogItemToProperty } from '@/app/(dashboard)/maintenance/actions'
import type {
  MaintenanceCatalogItem,
  MaintenanceCatalogCategory,
  ScheduleFrequency,
} from '@/types/database'
import {
  RECURRENCE_LABELS,
  CATALOG_CATEGORY_LABELS,
} from '@/types/database'
import { X, Loader2, Check } from 'lucide-react'

interface SelectedItem {
  catalogItem: MaintenanceCatalogItem
  recurrence:  ScheduleFrequency
  nextDueDate: string
}

interface Props {
  propertyId: string
  onComplete: () => void
  onClose:    () => void
}

export function CustomTemplateModal({ propertyId, onComplete, onClose }: Props) {
  const supabase = createClient()

  const [step,     setStep]     = useState<1 | 2>(1)
  const [catalog,  setCatalog]  = useState<MaintenanceCatalogItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [config,   setConfig]   = useState<Record<string, SelectedItem>>({})
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    supabase
      .from('maintenance_catalog_items')
      .select('*')
      .eq('is_active', true)
      .order('category')
      .order('sort_order')
      .then(({ data }) => {
        if (data) setCatalog(data as MaintenanceCatalogItem[])
        setLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byCategory = catalog.reduce<Record<string, MaintenanceCatalogItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = []
    acc[item.category].push(item)
    return acc
  }, {})

  function toggleItem(item: MaintenanceCatalogItem) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) {
        next.delete(item.id)
      } else {
        next.add(item.id)
        setConfig((c) => ({
          ...c,
          [item.id]: {
            catalogItem: item,
            recurrence:  (item.suggested_recurrence as ScheduleFrequency) ?? 'annual',
            nextDueDate: today,
          },
        }))
      }
      return next
    })
  }

  async function handleAdd() {
    setSaving(true)
    setError(null)

    for (const id of Array.from(selected)) {
      const itemConfig = config[id]
      if (!itemConfig) continue
      const result = await addCatalogItemToProperty(
        propertyId,
        itemConfig.catalogItem.id,
        itemConfig.nextDueDate,
        itemConfig.recurrence,
      )
      if (result.error) {
        setError(`Failed to add "${itemConfig.catalogItem.name}". Please try again.`)
        setSaving(false)
        return
      }
    }

    setSaving(false)
    onComplete()
  }

  const categories = Object.keys(byCategory) as MaintenanceCatalogCategory[]

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      <div className="relative w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh]"
           style={{ background: 'var(--bg-card)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-themed shrink-0">
          <div className="flex items-center gap-3">
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                className="text-sm font-medium"
                style={{ color: 'var(--accent-gold)' }}
              >
                ← Back
              </button>
            )}
            <div>
              <h2 className="font-bold text-primary-themed">
                {step === 1 ? 'Build Your Schedule' : 'Set Dates & Frequency'}
              </h2>
              <p className="text-xs text-muted-themed mt-0.5">
                {step === 1
                  ? `${selected.size} item${selected.size !== 1 ? 's' : ''} selected`
                  : `${selected.size} item${selected.size !== 1 ? 's' : ''} to configure`
                }
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step 1: select from catalog */}
        {step === 1 && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
              {loading ? (
                <div className="py-8 text-center text-sm text-muted-themed flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading catalog…
                </div>
              ) : (
                categories.map((cat) => (
                  <div key={cat}>
                    <h3 className="text-xs font-bold uppercase tracking-wider mb-2 px-1 text-muted-themed">
                      {CATALOG_CATEGORY_LABELS[cat] ?? cat}
                    </h3>
                    <div className="space-y-1">
                      {byCategory[cat].map((item) => {
                        const isSelected = selected.has(item.id)
                        return (
                          <button
                            key={item.id}
                            onClick={() => toggleItem(item)}
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-colors"
                            style={{
                              borderColor: isSelected ? 'var(--accent-gold)' : 'var(--border)',
                              background:  isSelected ? 'var(--accent-amber-dim)' : 'var(--bg-raised)',
                            }}
                          >
                            <div
                              className="w-5 h-5 rounded-md border-2 shrink-0 flex items-center justify-center transition-colors"
                              style={{
                                borderColor: isSelected ? 'var(--accent-gold)' : 'var(--border)',
                                background:  isSelected ? 'var(--accent-gold)' : 'transparent',
                              }}
                            >
                              {isSelected && <Check className="w-3 h-3" style={{ color: 'var(--bg-card)' }} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-primary-themed">{item.name}</span>
                              {item.suggested_recurrence && (
                                <span className="text-xs text-muted-themed ml-2">
                                  {RECURRENCE_LABELS[item.suggested_recurrence as ScheduleFrequency]}
                                </span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-4 py-4 border-t border-themed shrink-0">
              <button
                onClick={() => { if (selected.size > 0) setStep(2) }}
                disabled={selected.size === 0 || loading}
                className="btn-primary w-full py-3"
              >
                {selected.size === 0
                  ? 'Select items to continue'
                  : `Continue with ${selected.size} item${selected.size !== 1 ? 's' : ''} →`
                }
              </button>
            </div>
          </>
        )}

        {/* Step 2: configure dates/frequencies */}
        {step === 2 && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {Array.from(selected).map((id) => {
                const itemConfig = config[id]
                if (!itemConfig) return null
                return (
                  <div
                    key={id}
                    className="rounded-xl border border-themed p-3 space-y-2"
                    style={{ background: 'var(--bg-raised)' }}
                  >
                    <span className="text-sm font-medium text-primary-themed block">
                      {itemConfig.catalogItem.name}
                    </span>
                    <div className="flex items-center gap-2">
                      <select
                        value={itemConfig.recurrence}
                        onChange={(e) => setConfig((prev) => ({
                          ...prev,
                          [id]: { ...prev[id], recurrence: e.target.value as ScheduleFrequency },
                        }))}
                        className="flex-1 input py-1.5 text-xs"
                      >
                        {(Object.entries(RECURRENCE_LABELS) as [ScheduleFrequency, string][]).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                      <input
                        type="date"
                        value={itemConfig.nextDueDate}
                        onChange={(e) => setConfig((prev) => ({
                          ...prev,
                          [id]: { ...prev[id], nextDueDate: e.target.value },
                        }))}
                        className="flex-1 input py-1.5 text-xs"
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="px-4 py-4 border-t border-themed shrink-0 space-y-2">
              {error && (
                <p className="text-xs text-center" style={{ color: 'var(--accent-red)' }}>{error}</p>
              )}
              <button
                onClick={handleAdd}
                disabled={saving}
                className="btn-primary w-full py-3"
              >
                {saving
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding items…</>
                  : `Add ${selected.size} Item${selected.size !== 1 ? 's' : ''} to Schedule`
                }
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
