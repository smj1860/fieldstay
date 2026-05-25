import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { DashboardNav } from './dashboard-nav'
import { ReviewPrompt } from '@/components/review-prompt'

const MILESTONE_MESSAGES: Record<string, string> = {
  first_ical_sync:              'Your first bookings are syncing.',
  first_turnover_complete:      'First turnover done — FieldStay is working.',
  first_purchase_order:         'FieldStay just caught a restock before you ran out.',
  first_owner_portal_view:      'Your owner just viewed their P&L.',
  second_property_configured:   "You're managing multiple properties with FieldStay.",
  turnover_milestone_10:        '10 turnovers coordinated through FieldStay.',
  turnover_milestone_50:        '50 turnovers. That\'s serious volume.',
  thirty_days:                  "You've been running operations with FieldStay for a month.",
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Get the user's org — redirect to onboarding if none yet
  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id, role, organizations(name, plan, plan_status)')
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

  return (
    <div className="flex h-screen overflow-hidden bg-accent-50">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-brand-800 flex flex-col">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-brand-700">
          <span className="text-white text-xl font-bold tracking-tight">
            FieldStay
          </span>
          <p className="text-brand-300 text-xs mt-0.5 truncate">{org?.name}</p>
        </div>

        {/* Nav links */}
        <DashboardNav role={membership.role} />

        {/* Bottom: account */}
        <div className="p-4 border-t border-brand-700 mt-auto">
          <Link
            href="/settings"
            className="flex items-center gap-2 text-brand-200 hover:text-white text-sm transition-colors"
          >
            <span className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center text-xs font-bold text-white">
              {user.email?.[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="truncate">{user.email}</span>
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {pendingMilestone && MILESTONE_MESSAGES[pendingMilestone.milestone] && (
            <ReviewPrompt
              milestone={pendingMilestone.milestone}
              message={MILESTONE_MESSAGES[pendingMilestone.milestone]}
              orgId={membership.org_id}
            />
          )}
          {children}
        </div>
      </main>
    </div>
  )
}
