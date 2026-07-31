import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'
import { SetupVendorsStep } from './setup-vendors-client'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export default async function OnboardingVendorsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: vendors, error: vendorsError } = await supabase
    .from('vendors')
    .select('id, name, specialty, contact_name, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.setup.vendors', orgId: membership.org_id }, vendorsError)
  async function continueAction() {
    'use server'
    await markStepComplete('vendors', '/setup/inventory-template')
  }

  return <SetupVendorsStep vendors={vendors ?? []} continueAction={continueAction} />
}
