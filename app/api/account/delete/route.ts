import { NextRequest, NextResponse } from 'next/server'
import { cookies }                   from 'next/headers'
import { createServerClient }        from '@supabase/ssr'
import { createServiceClient }       from '@/lib/supabase/server'
import { logAuditEvent }             from '@/lib/audit'
import { revokeIntegrationToken }    from '@/lib/integrations/vault'
import { stripe }                    from '@/lib/stripe/client'
import { reportError }               from '@/lib/observability/report-error'

export async function DELETE(request: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Require confirmation string in body
  const body = await request.json().catch(() => null)
  if (body?.confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })
  }

  const admin = createServiceClient({ authenticatedUser: user })

  // Get all org memberships — user may belong to more than one org
  const { data: memberships, error: memberErr } = await admin
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)

  if (memberErr) {
    console.error('[account/delete] membership lookup', memberErr)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }

  const auditOrgIds: string[] = []

  for (const membership of memberships ?? []) {
    const orgId = membership.org_id as string

    // If owner, check no other members exist before deleting
    if (membership.role === 'owner') {
      const { count } = await admin
        .from('organization_members')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .neq('user_id', user.id)

      if ((count ?? 0) > 0) {
        return NextResponse.json(
          { error: 'Transfer ownership or remove all team members before deleting your account.' },
          { status: 409 }
        )
      }

      // Cancel Stripe subscription (owner-only)
      const { data: org } = await admin
        .from('organizations')
        .select('stripe_subscription_id, repuguard_stripe_subscription_id')
        .eq('id', orgId)
        .single()

      if (org?.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(org.stripe_subscription_id as string)
        } catch (err) {
          // Abort the deletion — a swallowed failure leaves an active Stripe
          // subscription with no FieldStay account to manage it (billing leak).
          console.error(`[Account:${user.id}] Stripe cancel failed:`, err)
          reportError(err, { site: 'route.account.delete.stripe_cancel', orgId })
          return NextResponse.json(
            {
              error: 'Unable to cancel your subscription at this time. Please try again in a few minutes, or contact support at support@fieldstay.app if the issue persists.',
            },
            { status: 503 }
          )
        }
      }
      if (org?.repuguard_stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(org.repuguard_stripe_subscription_id as string)
        } catch (err) {
          // Abort the deletion — same billing-leak risk as the main subscription.
          console.error(`[Account:${user.id}] RepuGuard Stripe cancel failed:`, err)
          reportError(err, { site: 'route.account.delete.repuguard_stripe_cancel', orgId })
          return NextResponse.json(
            {
              error: 'Unable to cancel your subscription at this time. Please try again in a few minutes, or contact support at support@fieldstay.app if the issue persists.',
            },
            { status: 503 }
          )
        }
      }
    }

    auditOrgIds.push(orgId)
  }

  // Only reached if all orgs' Stripe cancels succeeded — write audit events
  // after the full loop so a mid-loop 503 never leaves a premature
  // "account.deleted" record for an org whose subscription is still active.
  for (const orgId of auditOrgIds) {
    await logAuditEvent({
      orgId:   orgId,
      actorId: user.id,
      action:  'account.deleted',
    }).catch(err => {
      console.error(`[Account:${user.id}] audit log failed for ${orgId}:`, err)
      reportError(err, { site: 'route.account.delete.audit_log', orgId })
    })
  }

  // Revoke integration tokens — user-level, done once after per-org cleanup
  const { data: connections } = await admin
    .from('integration_connections')
    .select('provider_id')
    .eq('user_id', user.id)

  for (const conn of connections ?? []) {
    try {
      await revokeIntegrationToken(user.id, conn.provider_id as string)
    } catch (err) {
      console.error(`[Account:${user.id}] vault revoke failed for ${conn.provider_id}:`, err)
      reportError(err, {
        site: 'route.account.delete.vault_revoke',
        extra: { provider_id: conn.provider_id as string },
      })
    }
  }

  // Delete the auth user (cascades to org data via DB foreign keys)
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
  if (deleteError) {
    console.error(`[Account:${user.id}] deleteUser failed:`, deleteError.message)
    return NextResponse.json({ error: 'Failed to delete account. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
