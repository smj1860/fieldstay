'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { StandardTemplateModal } from '@/components/onboarding/StandardTemplateModal'
import { completeMaintenanceStep } from './actions'
import { Loader2 } from 'lucide-react'
import { Button, buttonVariantClass } from '@/components/ui/Button'

interface Props {
  propertyId: string
}

// "Build Custom Schedule" (CustomTemplateModal) removed per the Templates
// Hub project's "hybrid" decision — a custom, non-standard schedule is now
// built via Templates → Maintenance → Create Template instead of inline
// here. Standard Template stays, since applying the real seeded 36-item
// schedule as-is is still the fast path for a new property.
//
// The custom path is now a LINK to that builder rather than prose telling the
// PM where to go afterwards. Nothing was wired to the removed inline form, so
// the only route to a non-standard schedule was reading the paragraph above
// and navigating there by hand — and the step's own actions.ts still carried
// the orphaned addMaintenanceSchedule behind it (deleted with this change).
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
          Apply the standard FieldStay maintenance schedule now, or build your
          own template and apply that instead.
        </p>

        <div className="mt-8 w-full flex flex-col gap-3">
          <Button
            onClick={() => setShowStandardModal(true)}
            className="w-full py-4 rounded-xl text-sm font-semibold transition-colors"
          >
            Use Standard Template
          </Button>
          <Link
            href="/templates/maintenance/create"
            className={`${buttonVariantClass('secondary')} w-full py-4 rounded-xl text-sm font-semibold transition-colors`}
          >
            Create Template
          </Link>
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
