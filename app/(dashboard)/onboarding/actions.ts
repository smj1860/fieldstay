'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { ONBOARDING_STEPS } from '@/lib/onboarding-wizard'

export async function markStepComplete(
  stepKey: string,
  nextHref?: string
): Promise<void> {
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

  revalidatePath('/onboarding')

  if (nextHref) {
    redirect(nextHref)
  } else {
    // Find next incomplete step
    const next = ONBOARDING_STEPS.find((s) => !completed[s.key])
    if (next) {
      redirect(`/onboarding/${next.href}`)
    } else {
      redirect('/ops')
    }
  }
}
