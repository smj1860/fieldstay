import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { firstIncompleteOnboardingStep } from '@/lib/onboarding-wizard'

export default async function OnboardingIndexPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('onboarding_steps_completed')
    .eq('id', membership.org_id)
    .single()

  const completed = (org?.onboarding_steps_completed ?? {}) as Record<string, boolean>
  const href      = firstIncompleteOnboardingStep(completed)

  redirect(`/onboarding/${href}`)
}
