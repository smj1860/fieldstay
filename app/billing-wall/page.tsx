import { redirect }     from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function BillingWallPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: row } = await supabase
    .from('organization_members')
    .select('org_id, organizations(name, plan_status, trial_ends_at)')
    .eq('user_id', user.id)
    .single()

  if (!row) redirect('/login')

  const org = Array.isArray(row.organizations)
    ? row.organizations[0]
    : row.organizations

  const planStatus  = org?.plan_status  ?? 'cancelled'
  const trialEndsAt = org?.trial_ends_at ?? null

  const trialExpired = planStatus === 'trialing'
    && trialEndsAt !== null
    && new Date(trialEndsAt) < new Date()

  if (!trialExpired && planStatus !== 'cancelled' && planStatus !== 'paused') {
    redirect('/ops')
  }

  const heading = trialExpired
    ? 'Your trial has ended'
    : 'Your subscription is inactive'

  const subtext = trialExpired
    ? 'Subscribe to continue managing your properties with FieldStay.'
    : 'Your account has been deactivated. Reactivate your subscription to regain access.'

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'var(--bg-base)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-8 text-center"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
      >
        <p
          className="text-2xl font-bold tracking-tight mb-6"
          style={{ color: 'var(--text-primary)' }}
        >
          FieldStay
        </p>

        <h1
          className="text-xl font-semibold mb-2"
          style={{ color: 'var(--text-primary)' }}
        >
          {heading}
        </h1>

        <p
          className="text-sm mb-8"
          style={{ color: 'var(--text-muted)' }}
        >
          {subtext}
        </p>

        <div className="flex flex-col gap-3">
          <a
            href="/settings?tab=Billing"
            className="btn-primary py-3 text-base text-center block rounded-xl"
            style={{ background: 'var(--accent-gold)', color: '#0a1628', fontWeight: 700 }}
          >
            {trialExpired ? 'Subscribe Now' : 'Reactivate Subscription'}
          </a>

          <a
            href={`mailto:support@fieldstay.app`}
            className="text-sm"
            style={{ color: 'var(--text-muted)' }}
          >
            Need help? Contact support
          </a>
        </div>
      </div>
    </div>
  )
}
