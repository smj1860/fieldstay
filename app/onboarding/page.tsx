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

  return <OnboardingForm userEmail={user.email ?? ''} />
}
