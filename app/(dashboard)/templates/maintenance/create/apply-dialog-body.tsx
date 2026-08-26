'use client'

import { CheckCircle2 } from 'lucide-react'
import { InlineAlert } from '@/components/ui/InlineAlert'
import type { BroadcastResult } from '@/app/(dashboard)/maintenance/maintenance-template-actions'
import type { Property } from './template-builder-shared'
import { PropertySelectList } from './property-select-list'

interface ApplyDialogBodyProps {
  properties:            Property[]
  applyResult:           BroadcastResult | null
  applyMode:             'all' | 'select'
  onApplyModeChange:     (mode: 'all' | 'select') => void
  selectedPropertyIds:   string[]
  onToggleProperty:      (id: string) => void
  allPropertiesSelected: boolean
  onToggleAllProperties: () => void
}

function ApplyResultSummary({ applyResult }: Readonly<{ applyResult: BroadcastResult }>) {
  const skipped = applyResult.skipped ?? 0
  return (
    <InlineAlert tone="success" className="flex items-start gap-2">
      <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">Template applied</p>
        <p className="mt-1">
          Created {applyResult.created} schedule{applyResult.created !== 1 ? 's' : ''}
          {skipped > 0 && <> · {skipped} skipped (already existed)</>}
        </p>
      </div>
    </InlineAlert>
  )
}

/** Main body of ApplyTemplateDialog — result summary, empty state, or the
 *  mode picker + property list. Split out to keep ApplyTemplateDialog's own
 *  Cognitive Complexity (SonarCloud typescript:S3776) under threshold. */
export function ApplyDialogBody({
  properties,
  applyResult,
  applyMode,
  onApplyModeChange,
  selectedPropertyIds,
  onToggleProperty,
  allPropertiesSelected,
  onToggleAllProperties,
}: Readonly<ApplyDialogBodyProps>) {
  if (applyResult) {
    return <ApplyResultSummary applyResult={applyResult} />
  }

  if (properties.length === 0) {
    return <p className="text-sm text-muted-themed">No properties found to apply this template to. You can broadcast it later from Saved Templates.</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-secondary-themed">Apply this template&apos;s schedules now?</p>
      <PropertySelectList
        properties={properties}
        applyMode={applyMode}
        onApplyModeChange={onApplyModeChange}
        selectedPropertyIds={selectedPropertyIds}
        onToggleProperty={onToggleProperty}
        allPropertiesSelected={allPropertiesSelected}
        onToggleAllProperties={onToggleAllProperties}
      />
    </div>
  )
}
