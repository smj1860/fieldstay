'use client'

import { useState, useTransition } from 'react'
import { StandardTemplateModal } from '@/components/onboarding/StandardTemplateModal'
import { completeMaintenanceStep } from './actions'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface Props {
  propertyId: string
}

// "Build Custom Schedule" (CustomTemplateModal) removed per the Templates
// Hub project's "hybrid" decision — a custom, non-standard schedule is now
// built via Templates → Maintenance → Create Template instead of inline
// here. Standard Template stays, since applying the real seeded 36-item
// schedule as-is is still the fast path for a new property.
export function MaintenanceSetupStep({ propertyId }: Props) {
  const [showStandardModal, setShowStandardModal] = useState(false)
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
          Apply the standard FieldStay maintenance schedule now, or skip and
          build a custom one later from Templates → Maintenance.
        </p>

        <div className="mt-8 w-full">
          <Button
            onClick={() => setShowStandardModal(true)}
            className="w-full py-4 rounded-xl text-sm font-semibold transition-colors"
          >
            Use Standard Template
          </Button>
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

      {showStandardModal && (
        <StandardTemplateModal
          propertyId={propertyId}
          onComplete={advance}
          onClose={() => setShowStandardModal(false)}
        />
      )}
    </>
  )
}
