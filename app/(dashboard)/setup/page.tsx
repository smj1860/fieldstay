import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { ONBOARDING_STEPS, firstIncompleteOnboardingStep } from '@/lib/onboarding-wizard'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export default async function OnboardingIndexPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('onboarding_steps_completed')
    .eq('id', membership.org_id)
    .single()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.setup', orgId: membership.org_id }, orgError)
  const completed = (org?.onboarding_steps_completed ?? {}) as Record<string, boolean>

  // If power_ups is the only remaining step, skip it and go straight to the app
  const incompleteKeys = ONBOARDING_STEPS.filter((s) => !completed[s.key]).map((s) => s.key)
  if (incompleteKeys.length === 0 || (incompleteKeys.length === 1 && incompleteKeys[0] === 'power_ups')) {
    redirect('/ops')
  }

  const href = firstIncompleteOnboardingStep(completed)
  redirect(`/setup/${href}`)
}
