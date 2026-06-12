import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'
import { SetupCrewStep } from './setup-crew-client'

export default async function OnboardingCrewPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, specialty, role, is_active, email, invite_sent_at, user_id')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  async function continueAction() {
    'use server'
    await markStepComplete('crew', '/setup/auto-assign')
  }

  return <SetupCrewStep crew={crew ?? []} continueAction={continueAction} />
}
