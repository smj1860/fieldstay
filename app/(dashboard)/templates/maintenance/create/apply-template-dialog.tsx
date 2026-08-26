'use client'

import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import type { BroadcastResult } from '@/app/(dashboard)/maintenance/maintenance-template-actions'
import type { Property } from './template-builder-shared'
import { ApplyDialogFooter } from './apply-dialog-footer'
import { ApplyDialogBody } from './apply-dialog-body'

interface ApplyTemplateDialogProps {
  open:                  boolean
  templateName:          string
  properties:            Property[]
  applyMode:             'all' | 'select'
  onApplyModeChange:     (mode: 'all' | 'select') => void
  selectedPropertyIds:   string[]
  onToggleProperty:      (id: string) => void
  allPropertiesSelected: boolean
  onToggleAllProperties: () => void
  applying:              boolean
  applyError:            string | null
  applyResult:           BroadcastResult | null
  onApply:               () => void
  onClose:               () => void
}

/**
 * Post-creation "apply this template to properties now?" dialog. This was
 * the single largest contributor to create-template-builder.tsx's Cognitive
 * Complexity (SonarCloud typescript:S3776) — extracted here, and further
 * split into ApplyDialogFooter / ApplyDialogBody / PropertySelectList so
 * each piece is scored independently and stays well under threshold.
 */
export function ApplyTemplateDialog({
  open,
  templateName,
  properties,
  applyMode,
  onApplyModeChange,
  selectedPropertyIds,
  onToggleProperty,
  allPropertiesSelected,
  onToggleAllProperties,
  applying,
  applyError,
  applyResult,
  onApply,
  onClose,
}: Readonly<ApplyTemplateDialogProps>) {
  const isDone = applyResult !== null || properties.length === 0
  const applyDisabled = applying || (applyMode === 'select' && selectedPropertyIds.length === 0)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Apply Template"
      maxWidthClassName="max-w-md"
      footer={<ApplyDialogFooter isDone={isDone} applying={applying} disabled={applyDisabled} onApply={onApply} onClose={onClose} />}
    >
      <p className="text-xs text-muted-themed -mt-3 mb-4">&quot;{templateName}&quot; was created</p>

      {applyError && <InlineAlert tone="error" className="mb-4">{applyError}</InlineAlert>}

      <ApplyDialogBody
        properties={properties}
        applyResult={applyResult}
        applyMode={applyMode}
        onApplyModeChange={onApplyModeChange}
        selectedPropertyIds={selectedPropertyIds}
        onToggleProperty={onToggleProperty}
        allPropertiesSelected={allPropertiesSelected}
        onToggleAllProperties={onToggleAllProperties}
      />
    </Dialog>
  )
}
