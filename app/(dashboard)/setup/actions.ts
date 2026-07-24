'use server'

import { redirect, unstable_rethrow } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { ONBOARDING_STEPS } from '@/lib/onboarding-wizard'

export async function markStepComplete(
  stepKey: string,
  nextHref?: string
): Promise<void> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: org } = await supabase
      .from('organizations')
      .select('onboarding_steps_completed')
      .eq('id', membership.org_id)
      .single()

    const completed = { ...(org?.onboarding_steps_completed ?? {}) as Record<string, boolean>, [stepKey]: true }

    await supabase
      .from('organizations')
      .update({ onboarding_steps_completed: completed })
      .eq('id', membership.org_id)

    revalidatePath('/setup')

    if (nextHref) {
      redirect(nextHref)
    } else {
      // Find next incomplete step
      const next = ONBOARDING_STEPS.find((s) => !completed[s.key])
      if (next) {
        redirect(`/setup/${next.href}`)
      } else {
        redirect('/ops')
      }
    }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[markStepComplete]', err)
    throw err
  }
}
