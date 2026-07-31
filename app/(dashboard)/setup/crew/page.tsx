import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'
import { SetupCrewStep } from './setup-crew-client'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export default async function OnboardingCrewPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew, error: crewError } = await supabase
    .from('crew_members')
    .select('id, name, specialty, role, is_active, email, invite_sent_at, user_id')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.setup.crew', orgId: membership.org_id }, crewError)
  async function continueAction() {
    'use server'
    await markStepComplete('crew', '/setup/auto-assign')
  }

  return <SetupCrewStep crew={crew ?? []} continueAction={continueAction} />
}
