import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { SettingsTabs, type ConnectionInfo } from './settings-tabs'
import type { Organization } from '@/types/database'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, billing_email, plan, plan_status, trial_ends_at, max_properties, stripe_customer_id, auto_assign_mode, comms_log_retention_days, slack_webhook_url')
    .eq('id', membership.org_id)
    .single()

  const admin = createServiceClient()
  const { data: connections } = await admin
    .from('integration_connections')
    .select('provider_id, status, external_user_id, connected_at, metadata')
    .eq('org_id', membership.org_id)
    .in('status', ['active', 'error'])   // include errored connections so UI can surface them

  const connectionsByProvider = Object.fromEntries(
    (connections ?? []).map((c) => [c.provider_id, c as ConnectionInfo])
  )

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Manage your organization, billing, security, and notifications</p>
      </div>

      <SettingsTabs org={org as unknown as Organization} connections={connectionsByProvider} />
    </div>
  )
}
