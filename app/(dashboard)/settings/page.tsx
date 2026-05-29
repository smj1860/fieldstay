import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { SettingsTabs } from './settings-tabs'
import type { Organization } from '@/types/database'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, billing_email, plan, plan_status, trial_ends_at, max_properties, stripe_customer_id')
    .eq('id', membership.org_id)
    .single()

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Manage your organization, billing, security, and notifications</p>
      </div>

      <SettingsTabs org={org as unknown as Organization} />
    </div>
  )
}
