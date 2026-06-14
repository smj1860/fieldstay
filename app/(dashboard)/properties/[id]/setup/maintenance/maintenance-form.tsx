'use client'

import { useState, useTransition } from 'react'
import { StandardTemplateModal } from '@/components/onboarding/StandardTemplateModal'
import { CustomTemplateModal }   from '@/components/onboarding/CustomTemplateModal'
import { completeMaintenanceStep } from './actions'
import { Loader2 } from 'lucide-react'

interface Props {
  propertyId: string
}

export function MaintenanceSetupStep({ propertyId }: Props) {
  const [modal, setModal] = useState<'standard' | 'custom' | null>(null)
  const [completing, startComplete] = useTransition()

  function advance() {
    startComplete(async () => {
      await completeMaintenanceStep(propertyId)
    })
  }

  return (
    <>
      <div className="flex flex-col items-center px-2 pt-4 pb-8 max-w-md mx-auto">
        <h2 className="text-xl font-bold text-primary-themed text-center">
          Set Up Maintenance Schedule
        </h2>
        <p className="text-sm text-muted-themed text-center mt-2 max-w-xs">
          Add recurring maintenance items for this property. You can always customize later.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mt-8 w-full">
          <button
            onClick={() => setModal('custom')}
            className="flex-1 py-4 rounded-xl border text-sm font-semibold transition-colors btn-secondary"
          >
            Build Custom Schedule
          </button>
          <button
            onClick={() => setModal('standard')}
            className="flex-1 py-4 rounded-xl text-sm font-semibold transition-colors btn-primary"
          >
            Use Standard Template
          </button>
        </div>

        <button
          onClick={advance}
          disabled={completing}
          className="mt-6 text-xs text-muted-themed hover:text-secondary-themed underline flex items-center gap-1"
        >
          {completing && <Loader2 className="w-3 h-3 animate-spin" />}
          Skip for now
        </button>
      </div>

      {modal === 'standard' && (
        <StandardTemplateModal
          propertyId={propertyId}
          onComplete={advance}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'custom' && (
        <CustomTemplateModal
          propertyId={propertyId}
          onComplete={advance}
          onClose={() => setModal(null)}
        />
      )}
    </>
  )
}
