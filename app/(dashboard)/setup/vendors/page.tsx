import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'
import { SetupVendorsStep } from './setup-vendors-client'

export default async function OnboardingVendorsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, name, specialty, contact_name, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  async function continueAction() {
    'use server'
    await markStepComplete('vendors', '/setup/inventory-template')
  }

  return <SetupVendorsStep vendors={vendors ?? []} continueAction={continueAction} />
}
