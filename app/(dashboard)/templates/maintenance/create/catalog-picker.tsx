'use client'

import { useMemo } from 'react'
import { ChevronDown, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Checkbox } from '@/components/ui/Checkbox'
import { SPECIALTY_LABELS, FREQUENCY_LABELS, type CatalogItem } from './template-builder-shared'

interface CatalogPickerProps {
  catalogItems: CatalogItem[]
  show:         boolean
  onToggleShow: () => void
  isSelected:   (catalogId: string) => boolean
  allSelected:  boolean
  onToggleItem: (item: CatalogItem) => void
  onToggleAll:  () => void
}

/**
 * "Add from FieldStay Standard" section on the template builder. Split out
 * of create-template-builder.tsx specifically to bring that function's
 * Cognitive Complexity (SonarCloud typescript:S3776) under threshold — this
 * component owns its own grouping/sort logic and is scored independently.
 */
export function CatalogPicker({
  catalogItems,
  show,
  onToggleShow,
  isSelected,
  allSelected,
  onToggleItem,
  onToggleAll,
}: Readonly<CatalogPickerProps>) {
  const groups = useMemo(() => {
    const byKey: Record<string, CatalogItem[]> = {}
    for (const ci of catalogItems) {
      const key = ci.vendor_specialty_hint ?? 'general'
      if (!byKey[key]) byKey[key] = []
      byKey[key].push(ci)
    }
    return byKey
  }, [catalogItems])

  const groupKeys = useMemo(() => Object.keys(groups).sort((a, b) => {
    if (a === 'general') return 1
    if (b === 'general') return -1
    return (SPECIALTY_LABELS[a] ?? a).localeCompare(SPECIALTY_LABELS[b] ?? b)
  }), [groups])

  return (
    <div className="border border-themed rounded-xl bg-canvas-themed">
      <button
        type="button"
        onClick={onToggleShow}
        className="flex items-center justify-between w-full text-left p-3"
      >
        <span className="text-sm font-medium text-secondary-themed">
          Add from FieldStay Standard <span className="text-muted-themed font-normal">({catalogItems.length} items)</span>
        </span>
        <ChevronDown className={cn('w-4 h-4 text-muted-themed transition-transform flex-shrink-0', show && 'rotate-180')} />
      </button>
      {show && (
        <div className="px-3 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-themed">Select items to include in this template</p>
            <button type="button" onClick={onToggleAll} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
            {groupKeys.map((key) => (
              <div key={key}>
                <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">
                  {SPECIALTY_LABELS[key] ?? key}
                </p>
                <div className="space-y-1">
                  {groups[key].map((ci) => (
                    <label key={ci.id} className="flex items-center gap-2.5 text-sm bg-card-themed rounded-lg px-3 py-1.5 cursor-pointer border border-themed">
                      <Checkbox
                        checked={isSelected(ci.id)}
                        onChange={() => onToggleItem(ci)}
                        className="flex-shrink-0"
                      />
                      <span className="text-secondary-themed flex-1 truncate">{ci.name}</span>
                      {ci.is_optional_flag && (
                        <Badge tone="amber" className="text-xs flex-shrink-0 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {ci.is_optional_flag}
                        </Badge>
                      )}
                      <Badge tone="slate" className="text-xs flex-shrink-0">
                        {FREQUENCY_LABELS[ci.schedule_frequency] ?? ci.schedule_frequency}
                      </Badge>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
