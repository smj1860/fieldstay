'use client'

import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/Checkbox'
import type { Property } from './template-builder-shared'

interface PropertySelectListProps {
  properties:            Property[]
  applyMode:             'all' | 'select'
  onApplyModeChange:     (mode: 'all' | 'select') => void
  selectedPropertyIds:   string[]
  onToggleProperty:      (id: string) => void
  allPropertiesSelected: boolean
  onToggleAllProperties: () => void
}

/** Mode toggle ("all" vs "select") plus the property checkbox list, for the
 *  apply-template dialog. Split out to keep ApplyTemplateDialog's own
 *  Cognitive Complexity (SonarCloud typescript:S3776) under threshold. */
export function PropertySelectList({
  properties,
  applyMode,
  onApplyModeChange,
  selectedPropertyIds,
  onToggleProperty,
  allPropertiesSelected,
  onToggleAllProperties,
}: Readonly<PropertySelectListProps>) {
  return (
    <>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onApplyModeChange('all')}
          className={cn(
            'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
            applyMode === 'all' ? 'font-medium' : 'border-themed text-secondary-themed'
          )}
          style={applyMode === 'all' ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
        >
          All properties ({properties.length})
        </button>
        <button
          type="button"
          onClick={() => onApplyModeChange('select')}
          className={cn(
            'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
            applyMode === 'select' ? 'font-medium' : 'border-themed text-secondary-themed'
          )}
          style={applyMode === 'select' ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
        >
          Select properties
        </button>
      </div>

      {applyMode === 'select' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-secondary-themed">Properties</p>
            <button type="button" onClick={onToggleAllProperties} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
              {allPropertiesSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {properties.map((p) => (
              <label key={p.id} className="flex items-center gap-2.5 text-sm bg-canvas-themed rounded-lg px-3 py-2 cursor-pointer">
                <Checkbox
                  checked={selectedPropertyIds.includes(p.id)}
                  onChange={() => onToggleProperty(p.id)}
                />
                <span className="text-secondary-themed">{p.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
