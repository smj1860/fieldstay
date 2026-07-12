import { requireAuth } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  const { user } = await requireAuth()

  // ── Crew-member guard ──────────────────────────────────────────────────────
  // A crew member has a crew_members.user_id record but no organization_members
  // row. If one lands here (e.g. via a back-button or stale URL), redirect them
  // before any onboarding logic runs.
  const admin = createServiceClient()

  const { data: crewRecord } = await admin
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (crewRecord) {
    await logAuditEvent({
      actorId:    user.id,
      action:     'security.route.mismatch',
      targetType: 'route',
      targetId:   '/onboarding',
      metadata: {
        crew_member_id: crewRecord.id,
        org_id:         crewRecord.org_id,
        reason:         'crew_member_reached_pm_onboarding',
      },
    })
    redirect('/crew')
  }
  // ── End crew-member guard ──────────────────────────────────────────────────

  // ── Resume-in-progress guard ────────────────────────────────────────────────
  // If this user already has an org (step 1 already completed — e.g. they
  // refreshed or navigated away mid-flow), don't make them re-submit the
  // name form. Skip straight to whichever step is actually still pending.
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (membership) {
    const { data: connection } = await admin
      .from('integration_connections')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('status', 'active')
      .maybeSingle()

    // Org exists and a PMS is already connected — onboarding is fully
    // done, nothing left for this page to do.
    if (connection) redirect('/ops')

    // Org exists but no PMS connected yet — resume at step 2 directly.
    return <OnboardingForm userEmail={user.email ?? ''} initialStep="connect-pms" />
  }
  // ── End resume-in-progress guard ────────────────────────────────────────────

  return <OnboardingForm userEmail={user.email ?? ''} />
}
