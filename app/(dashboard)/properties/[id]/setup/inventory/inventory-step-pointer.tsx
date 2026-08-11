'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { completeInventoryStep } from './actions'

export function InventoryStepPointer({ propertyId }: Readonly<{ propertyId: string }>) {
  const [completing, startComplete] = useTransition()

  function skip() {
    startComplete(async () => {
      await completeInventoryStep(propertyId)
    })
  }

  return (
    <div className="flex flex-col items-center px-2 pt-4 pb-8 max-w-md mx-auto text-center">
      <h2 className="text-xl font-bold text-primary-themed">Inventory Is Already Started</h2>
      <p className="text-sm text-muted-themed mt-2 max-w-xs">
        This property was stocked from your standard inventory template when it
        was created. Par levels that scale — towels, linens, coffee — are sized
        from its bedrooms, bathrooms and guest count. Add anything specific to
        this property, like pool or fire pit supplies, from Par Levels.
      </p>

      <Link href="/templates/inventory/par-levels" className="mt-8 w-full">
        <Button className="w-full py-4 rounded-xl text-sm font-semibold">
          Review Par Levels →
        </Button>
      </Link>

      <button
        type="button"
        onClick={skip}
        disabled={completing}
        className="mt-6 text-xs text-muted-themed hover:text-secondary-themed underline flex items-center gap-1"
      >
        {completing && <Loader2 className="w-3 h-3 animate-spin" />}
        Skip for now
      </button>
    </div>
  )
}
