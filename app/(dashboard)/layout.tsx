import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard-shell'
import { ReviewPrompt } from '@/components/review-prompt'

const MILESTONE_MESSAGES: Record<string, string> = {
  first_ical_sync:            'Your first bookings are syncing.',
  first_turnover_complete:    'First turnover done — FieldStay is working.',
  first_purchase_order:       'FieldStay just caught a restock before you ran out.',
  first_owner_portal_view:    'Your owner just viewed their P&L.',
  second_property_configured: "You're managing multiple properties with FieldStay.",
  turnover_milestone_10:      '10 turnovers coordinated through FieldStay.',
  turnover_milestone_50:      "50 turnovers. That's serious volume.",
  thirty_days:                "You've been running operations with FieldStay for a month.",
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id, role, organizations(name, plan, plan_status, max_properties)')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) redirect('/onboarding')

  const org = Array.isArray(membership.organizations)
    ? membership.organizations[0]
    : membership.organizations

  const { data: pendingMilestone } = await supabase
    .from('org_milestones')
    .select('milestone, achieved_at')
    .eq('org_id', membership.org_id)
    .eq('dismissed', false)
    .is('prompted_at', null)
    .order('achieved_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (pendingMilestone) {
    await supabase
      .from('org_milestones')
      .update({ prompted_at: new Date().toISOString() })
      .eq('org_id', membership.org_id)
      .eq('milestone', pendingMilestone.milestone)
  }

  return (
    <DashboardShell
      role={membership.role}
      orgName={org?.name ?? 'FieldStay'}
      userEmail={user.email ?? ''}
    >
      {pendingMilestone && MILESTONE_MESSAGES[pendingMilestone.milestone] && (
        <ReviewPrompt
          milestone={pendingMilestone.milestone}
          message={MILESTONE_MESSAGES[pendingMilestone.milestone]!}
          orgId={membership.org_id}
        />
      )}
      {children}
    </DashboardShell>
  )
}
