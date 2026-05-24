import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { SettingsTabs } from './settings-tabs'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: org },
    { data: crew },
    { data: vendors },
    { data: orgMembers },
  ] = await Promise.all([
    supabase
      .from('organizations')
      .select('id, name, billing_email, plan, plan_status, trial_ends_at, max_properties, stripe_customer_id')
      .eq('id', membership.org_id)
      .single(),

    supabase
      .from('crew_members')
      .select('id, name, email, phone, preferred_contact, specialty, is_active, notes')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('vendors')
      .select('id, name, contact_name, email, phone, specialty, portal_enabled, is_active, notes')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('organization_members')
      .select('id, org_id, user_id, role, invited_email, invite_accepted_at')
      .eq('org_id', membership.org_id)
      .order('created_at'),
  ])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Manage your organization, crew, vendors, and billing</p>
      </div>

      <SettingsTabs
        org={org!}
        crew={crew ?? []}
        vendors={vendors ?? []}
        orgMembers={orgMembers ?? []}
        currentRole={membership.role}
      />
    </div>
  )
}
