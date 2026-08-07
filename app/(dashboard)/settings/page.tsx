import type { Metadata } from 'next'
import { Suspense } from 'react'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { SettingsTabs, type ConnectionInfo } from './settings-tabs'
import type { Organization } from '@/types/database'
import { getHospitablePromoStatus } from '@/lib/queries/hospitable-promo'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    // slack_webhook_url is deliberately NOT selected. A Slack Incoming Webhook
    // is a bearer credential — anyone holding the URL can post arbitrary
    // messages into that channel from anywhere, with no further authentication
    // — and `orgs_select` grants every member of the org (viewer and crew
    // included) read access to every column of this row. Selecting it here
    // serialized that credential into the HTML of a page any member can open.
    //
    // The client only needs to know whether one is configured, so that is all
    // it gets; `slackWebhookConfigured` below carries the boolean and
    // updateSlackWebhook (now admin-gated) remains the only way to change it.
    .select('id, name, billing_email, plan, plan_status, trial_ends_at, max_properties, stripe_customer_id, auto_assign_mode, vendor_auto_assign_mode, comms_log_retention_days')
    .eq('id', membership.org_id)
    .single()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings', orgId: membership.org_id }, orgError)
  const admin = createServiceClient({ authorizedBy: membership })
  const { data: connections, error: connectionsError } = await admin
    .from('integration_connections')
    .select('provider_id, status, external_user_id, connected_at, metadata')
    .eq('org_id', membership.org_id)
    .in('status', ['active', 'error'])   // include errored connections so UI can surface them


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings', orgId: membership.org_id }, connectionsError)
  const connectionsByProvider = Object.fromEntries(
    (connections ?? []).map((c) => [c.provider_id, c as ConnectionInfo])
  )

  const { data: krogerStoreNeeded, error: krogerStoreNeededError } = await admin
    .from('org_milestones')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('milestone', 'kroger_store_needed')
    .maybeSingle()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings', orgId: membership.org_id }, krogerStoreNeededError)
  // Whether a Slack webhook is set, without the value ever leaving Postgres:
  // a head-only count ships no rows at all. See the note on the select above.
  const { count: slackConfiguredCount, error: slackConfiguredError } = await supabase
    .from('organizations')
    .select('id', { count: 'exact', head: true })
    .eq('id', membership.org_id)
    .not('slack_webhook_url', 'is', null)

  throwIfAnyQueryFailed({ site: 'page.settings', orgId: membership.org_id }, slackConfiguredError)

  const hospitablePromo = await getHospitablePromoStatus(membership.org_id)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Manage your organization, billing, security, and notifications</p>
      </div>

      <Suspense fallback={null}>
        <SettingsTabs
          org={org as unknown as Organization}
          connections={connectionsByProvider}
          krogerNeedsStore={!!krogerStoreNeeded}
          hospitablePromo={hospitablePromo}
          slackWebhookConfigured={(slackConfiguredCount ?? 0) > 0}
          canEditOrgSettings={membership.role === 'owner' || membership.role === 'admin'}
        />
      </Suspense>
    </div>
  )
}
