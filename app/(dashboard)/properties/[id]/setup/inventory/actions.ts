'use server'

import { redirect, unstable_rethrow } from 'next/navigation'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export async function completeInventoryStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'inventory')
    redirect(`/properties/${propertyId}/setup/checklist`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeInventoryStep]', err)
    throw err
  }
}
