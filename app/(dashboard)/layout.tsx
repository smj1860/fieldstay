import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireOrgMember } from '@/lib/auth'
import { DashboardShell } from '@/components/dashboard-shell'
import { DashboardToastProvider } from '@/components/dashboard-toast-provider'
import { SupportChatWidget } from '@/components/support/support-chat-widget'
import { ReviewPrompt } from '@/components/review-prompt'
import { NewPropertySetupPrompt } from '@/components/new-property-setup-prompt'
import { calcOnboardingProgress, ONBOARDING_STEPS } from '@/lib/onboarding-wizard'
import { getNotifications } from '@/lib/notifications'

export const metadata: Metadata = {
  manifest:   '/dashboard-manifest.json',
  themeColor: '#0D0E14',
}

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
}: Readonly<{
  children: React.ReactNode
}>) {
  // Request-memoized via React cache() in lib/auth.ts — the page rendered
  // inside this layout calls requireOrgMember() too, and both now share one
  // auth.getUser() + one organization_members query per request.
  const { user, supabase, membership } = await requireOrgMember()
  const org = membership.org

  const repuguardActive =
    org.repuguard_status === 'trial' || org.repuguard_status === 'active'

  const completedSteps  = org.onboarding_steps_completed
  const onboardingPct   = calcOnboardingProgress(completedSteps)
  const onboardingComplete = ONBOARDING_STEPS.every((s) => completedSteps[s.key])

  if (!onboardingComplete) {
    const hasStartedSetup = Object.values(completedSteps).some(Boolean)

    if (!hasStartedSetup) {
      const headersList = await headers()
      const pathname    = headersList.get('x-pathname') ?? ''

      // Routes that must stay reachable on a brand-new account:
      // /setup        — the wizard itself
      // /settings     — user may need billing or account access
      // /help         — support must always be reachable
      // /billing-wall — subscription gate must not loop
      const isExempt =
        pathname.startsWith('/setup')       ||
        pathname.startsWith('/settings')    ||
        pathname.startsWith('/help')        ||
        pathname.startsWith('/billing-wall')

      if (!isExempt) {
        redirect('/setup')
      }
    }
  }

  // ── Billing gate ──────────────────────────────────────────────────────────
  const planStatus  = org.plan_status
  const trialEndsAt = org.trial_ends_at

  const trialExpired = planStatus === 'trialing'
    && trialEndsAt !== null
    && new Date(trialEndsAt) < new Date()

  const isBlocked = trialExpired
    || planStatus === 'cancelled'
    || planStatus === 'paused'

  const isPastDue = planStatus === 'past_due'

  if (isBlocked) {
    const billingHeadersList = await headers()
    const billingPathname    = billingHeadersList.get('x-pathname') ?? ''
    const isBillingExempt =
      billingPathname.startsWith('/settings')    ||
      billingPathname.startsWith('/help')        ||
      billingPathname.startsWith('/billing-wall')
    if (!isBillingExempt) {
      redirect('/billing-wall')
    }
  }
  // ── End billing gate ──────────────────────────────────────────────────────

  // These five lookups are independent of each other — run them concurrently
  // instead of as a serial waterfall (this layout renders on every dashboard
  // navigation, so each serial round-trip here is paid app-wide).
  const [
    { data: pendingMilestone },
    { data: newPropertyMilestones },
    { data: staffRow },
    notifications,
    { count: unreadMessages },
  ] = await Promise.all([
    supabase
      .from('org_milestones')
      .select('milestone, achieved_at')
      .eq('org_id', membership.org_id)
      .eq('dismissed', false)
      .is('prompted_at', null)
      .order('achieved_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('org_milestones')
      .select('milestone, value')
      .eq('org_id', membership.org_id)
      .eq('dismissed', false)
      .like('milestone', 'new_property_setup:%')
      .order('achieved_at', { ascending: false })
      .limit(3),
    supabase
      .from('platform_staff')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle(),
    getNotifications(membership.org_id),
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', membership.org_id)
      .eq('recipient_id', user.id)
      .is('read_at', null),
  ])

  if (pendingMilestone) {
    // Mark the milestone as prompted AFTER the response streams — a write
    // has no business blocking every dashboard render. Uses the service
    // client because after() runs outside the request's cookie scope; the
    // update is scoped to the org_id we just authenticated via
    // requireOrgMember() plus the exact milestone key.
    const orgId = membership.org_id
    after(async () => {
      const admin = createServiceClient({ authorizedBy: membership })
      await admin
        .from('org_milestones')
        .update({ prompted_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('milestone', pendingMilestone.milestone)
    })
  }

  const { data: orgProperties } = newPropertyMilestones?.length
    ? await supabase
        .from('properties')
        .select('id, name')
        .eq('org_id', membership.org_id)
        .eq('is_active', true)
    : { data: null }

  const isStaff = !!staffRow

  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    user.email?.split('@')[0] ??
    'User'

  return (
    <DashboardToastProvider orgId={membership.org_id} userId={user.id}>
      <DashboardShell
        role={membership.role}
        orgName={org.name || 'FieldStay'}
        userName={displayName}
        userEmail={user.email ?? ''}
        repuguardActive={repuguardActive}
        onboardingComplete={onboardingComplete}
        onboardingPct={onboardingPct}
        notifications={notifications}
        unreadMessages={unreadMessages ?? 0}
        isStaff={isStaff}
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
          />
        )}
        {(newPropertyMilestones ?? []).map((m) => {
          const value = (m.value ?? {}) as { property_id?: string; property_name?: string }
          if (!value.property_id) return null

          return (
            <NewPropertySetupPrompt
              key={m.milestone}
              milestone={m.milestone}
              propertyId={value.property_id}
              propertyName={value.property_name ?? 'New property'}
              otherProperties={(orgProperties ?? []).filter((p) => p.id !== value.property_id)}
            />
          )
        })}
        {children}
      </DashboardShell>

      {/* AI support chat widget — PM dashboard only */}
      <SupportChatWidget />
    </DashboardToastProvider>
  )
}
