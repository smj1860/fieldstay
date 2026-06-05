import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard-shell'
import { ReviewPrompt } from '@/components/review-prompt'
import { calcOnboardingProgress, ONBOARDING_STEPS } from '@/lib/onboarding-wizard'

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
    .select('org_id, role, organizations(name, plan, plan_status, max_properties, trial_ends_at, repuguard_status, onboarding_steps_completed)')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) redirect('/onboarding')

  const org = Array.isArray(membership.organizations)
    ? membership.organizations[0]
    : membership.organizations

  const repuguardActive =
    org?.repuguard_status === 'trial' || org?.repuguard_status === 'active'

  const completedSteps  = (org?.onboarding_steps_completed ?? {}) as Record<string, boolean>
  const onboardingPct   = calcOnboardingProgress(completedSteps)
  const onboardingComplete = ONBOARDING_STEPS.every((s) => completedSteps[s.key])

  // ── Billing gate ──────────────────────────────────────────────────────────
  const planStatus  = org?.plan_status  ?? 'trialing'
  const trialEndsAt = org?.trial_ends_at ?? null

  const trialExpired = planStatus === 'trialing'
    && trialEndsAt !== null
    && new Date(trialEndsAt) < new Date()

  const isBlocked = trialExpired
    || planStatus === 'cancelled'
    || planStatus === 'paused'

  const isPastDue = planStatus === 'past_due'

  if (isBlocked) {
    redirect('/billing-wall')
  }
  // ── End billing gate ──────────────────────────────────────────────────────

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
      repuguardActive={repuguardActive}
      onboardingComplete={onboardingComplete}
      onboardingPct={onboardingPct}
    >
      {isPastDue && (
        <div
          className="mx-4 mt-4 px-4 py-3 rounded-xl flex items-center justify-between gap-4 text-sm"
          style={{
            background: 'var(--accent-red-dim)',
            border:     '1px solid rgba(240,84,84,0.3)',
          }}
        >
          <span style={{ color: 'var(--accent-red)' }}>
            <strong>Payment past due.</strong> Please update your payment method
            to avoid interruption.
          </span>
          <a
            href="/settings"
            className="text-xs font-semibold underline whitespace-nowrap"
            style={{ color: 'var(--accent-red)' }}
          >
            Update billing →
          </a>
        </div>
      )}
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
