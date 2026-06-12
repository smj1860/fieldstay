import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { ONBOARDING_STEPS, firstIncompleteOnboardingStep } from '@/lib/onboarding-wizard'

export default async function OnboardingIndexPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('onboarding_steps_completed')
    .eq('id', membership.org_id)
    .single()

  const completed = (org?.onboarding_steps_completed ?? {}) as Record<string, boolean>

  // If power_ups is the only remaining step, skip it and go straight to the app
  const incompleteKeys = ONBOARDING_STEPS.filter((s) => !completed[s.key]).map((s) => s.key)
  if (incompleteKeys.length === 0 || (incompleteKeys.length === 1 && incompleteKeys[0] === 'power_ups')) {
    redirect('/ops')
  }

  const href = firstIncompleteOnboardingStep(completed)
  redirect(`/setup/${href}`)
}
