'use client'

import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { RequiredMark } from '@/components/ui/RequiredMark'
import { SPECIALTY_LABELS, FREQUENCIES, type NewTemplateItem } from './template-builder-shared'

interface TemplateItemRowProps {
  index:     number
  item:      NewTemplateItem
  canRemove: boolean
  onUpdate:  (index: number, field: keyof NewTemplateItem, value: string) => void
  onRemove:  (index: number) => void
}

/** One row in the template builder's Items list. Extracted so the row's
 *  field markup doesn't count toward create-template-builder.tsx's
 *  Cognitive Complexity — this component's own complexity is trivial. */
export function TemplateItemRow({ index, item, canRemove, onUpdate, onRemove }: Readonly<TemplateItemRowProps>) {
  return (
    <div className="border border-themed rounded-xl p-3 space-y-2 bg-canvas-themed">
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label htmlFor={`mtx-item-name-${index}`} className="label text-xs">Item Name <RequiredMark /></label>
            <Input id={`mtx-item-name-${index}`} value={item.name} onChange={(e) => onUpdate(index, 'name', e.target.value)}
                   className="text-sm" placeholder="e.g. HVAC Filter Replacement" />
          </div>
          <div>
            <label htmlFor={`mtx-item-frequency-${index}`} className="label text-xs">Frequency</label>
            <select id={`mtx-item-frequency-${index}`} value={item.schedule_frequency}
                    onChange={(e) => onUpdate(index, 'schedule_frequency', e.target.value)}
                    className="input text-sm">
              {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`mtx-item-specialty-${index}`} className="label text-xs">Vendor Specialty</label>
            <select id={`mtx-item-specialty-${index}`} value={item.vendor_specialty_hint}
                    onChange={(e) => onUpdate(index, 'vendor_specialty_hint', e.target.value)}
                    className="input text-sm">
              <option value="">None</option>
              {Object.entries(SPECIALTY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`mtx-item-cost-${index}`} className="label text-xs">Est. Cost ($)</label>
            <Input id={`mtx-item-cost-${index}`} type="number" min="0" step="0.01" value={item.estimated_cost}
                   onChange={(e) => onUpdate(index, 'estimated_cost', e.target.value)}
                   className="text-sm" placeholder="0.00" />
          </div>
        </div>
        {canRemove && (
          <Button variant="ghost" type="button" onClick={() => onRemove(index)}
                  className="p-1.5 text-[var(--accent-red)] hover:opacity-80 mt-5 flex-shrink-0">
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
