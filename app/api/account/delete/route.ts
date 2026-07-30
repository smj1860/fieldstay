import { NextRequest, NextResponse } from 'next/server'
import { cookies }                   from 'next/headers'
import { createServerClient }        from '@supabase/ssr'
import { Ratelimit }                 from '@upstash/ratelimit'
import { createServiceClient }       from '@/lib/supabase/server'
import { redis }                     from '@/lib/rate-limit'
import { logAuditEvents }            from '@/lib/audit'
import { revokeIntegrationToken }    from '@/lib/integrations/vault'
import { stripe }                    from '@/lib/stripe/client'
import { reportError }               from '@/lib/observability/report-error'

type Admin = ReturnType<typeof createServiceClient>

/**
 * Org-scoped tables that do NOT (yet) have a FOREIGN KEY to organizations,
 * so deleting the organizations row does not cascade to them. Verified
 * against the live schema on 2026-07-30: every other org_id-bearing table
 * has `REFERENCES organizations(id) ON DELETE CASCADE` (audit_events and
 * system_job_runs are deliberately ON DELETE SET NULL — retained history).
 *
 * These are deleted explicitly, before the organizations row, so the purge
 * is complete regardless of whether the FK-backfill migration has been
 * applied. Once those FKs exist the explicit delete simply becomes a no-op
 * that removes rows the cascade would have removed anyway — it stays correct
 * either way, so this list is a safety net, not a duplicate of the cascade.
 *
 * Order is FK-safe: none of these reference each other, and all of their own
 * child tables (e.g. inventory_template_items, inventory_count_draft_items)
 * cascade from the parent rows removed here.
 */
const ORG_TABLES_WITHOUT_CASCADE = [
  'asset_depreciation_entries',
  'assignment_outcomes',
  'vendor_assignment_outcomes',
  'crew_availability',
  'inventory_count_drafts',
  'inventory_templates',
  'maintenance_schedule_templates',
  'messages',
] as const

// Account deletion is an irreversible, org-wide destructive action reachable
// with only a session cookie + a password. Throttle it per user so a stolen
// session can't be used to brute-force the re-auth password check.
// /api/account/delete is a BYPASS_ROUTE in proxy.ts (it does its own auth),
// so it gets no limiter from rateLimiterForPathname() — hence inline here,
// same as /accept-invite and /crew-invite.
const accountDeleteRatelimit = new Ratelimit({
  redis,
  limiter:   Ratelimit.slidingWindow(5, '15 m'),
  analytics: false,
  prefix:    'rl:account-delete',
})

const upstashConfigured = () =>
  !!process.env.upstash_fieldstay_KV_REST_API_URL &&
  !!process.env.upstash_fieldstay_KV_REST_API_TOKEN

/** Fails OPEN on a Redis outage — an infra blip must not strand a user who
 *  is legitimately trying to delete their account (a GDPR obligation). The
 *  password re-auth below is the real gate; this is defence in depth. */
async function isRateLimited(userId: string): Promise<boolean> {
  if (!upstashConfigured()) return false
  try {
    const { success } = await accountDeleteRatelimit.limit(`account-delete:${userId}`)
    return !success
  } catch (err) {
    console.error('[account/delete] rate limit check failed', err)
    reportError(err, { site: 'route.account.delete.rate_limit' })
    return false
  }
}

/**
 * Re-authentication. A full account + organization wipe must not be
 * reachable from a session cookie alone (a borrowed/stolen laptop, an XSS'd
 * tab). Verified against an ISOLATED Supabase client with no cookie access,
 * so the sign-in attempt cannot mutate the caller's live session.
 */
async function passwordIsValid(email: string, password: string): Promise<boolean> {
  const isolated = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )
  const { error } = await isolated.auth.signInWithPassword({ email, password })
  return !error
}

/**
 * A Stripe cancel that has already happened. Retrying the whole delete flow
 * after a partial failure must not 503 forever on a subscription that was
 * successfully cancelled on the previous attempt.
 */
function isAlreadyCancelled(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  if (e?.code === 'resource_missing') return true
  const msg = e?.message ?? ''
  return msg.includes("status 'canceled'") || msg.includes('No such subscription')
}

/** Guard: an owner may only delete their account when they are the org's
 *  ONLY member. Fails CLOSED — a failed count must never read as zero. */
async function assertSoleMember(
  admin: Admin,
  orgId: string,
  userId: string
): Promise<NextResponse | null> {
  const { count, error } = await admin
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .neq('user_id', userId)

  if (error || count === null || count === undefined) {
    console.error('[account/delete] other-member count failed', error)
    reportError(error ?? new Error('null count'), {
      site: 'route.account.delete.member_count',
      orgId,
    })
    return NextResponse.json(
      { error: 'Unable to verify your organization right now. Please try again in a few minutes.' },
      { status: 503 }
    )
  }

  if (count > 0) {
    return NextResponse.json(
      { error: 'Transfer ownership or remove all team members before deleting your account.' },
      { status: 409 }
    )
  }

  return null
}

/**
 * Cancel both Stripe subscriptions for an owned org and clear the stored ids
 * so a retried delete does not re-attempt an already-cancelled subscription.
 * Aborts the whole flow on a real failure — a swallowed error leaves an
 * active subscription with no FieldStay account to manage it (billing leak).
 */
async function cancelOrgSubscriptions(
  admin: Admin,
  orgId: string,
  userId: string
): Promise<NextResponse | null> {
  const { data: org, error } = await admin
    .from('organizations')
    .select('stripe_subscription_id, repuguard_stripe_subscription_id')
    .eq('id', orgId)
    .maybeSingle()

  // Abort on a read failure. Treating this as "no subscriptions" would skip
  // BOTH cancel blocks and delete the user with live billing attached.
  if (error) {
    console.error('[account/delete] organization lookup failed', error)
    reportError(error, { site: 'route.account.delete.org_lookup', orgId })
    return NextResponse.json(
      { error: 'Unable to verify your subscription right now. Please try again in a few minutes.' },
      { status: 503 }
    )
  }
  if (!org) return null

  const subs: Array<{ id: string; column: string; site: string }> = []
  if (org.stripe_subscription_id) {
    subs.push({
      id:     org.stripe_subscription_id as string,
      column: 'stripe_subscription_id',
      site:   'route.account.delete.stripe_cancel',
    })
  }
  if (org.repuguard_stripe_subscription_id) {
    subs.push({
      id:     org.repuguard_stripe_subscription_id as string,
      column: 'repuguard_stripe_subscription_id',
      site:   'route.account.delete.repuguard_stripe_cancel',
    })
  }

  if (!subs.length) return null

  const cleared: Record<string, null> = {}
  for (const sub of subs) {
    try {
      await stripe.subscriptions.cancel(sub.id)
    } catch (err) {
      if (!isAlreadyCancelled(err)) {
        console.error(`[Account:${userId}] Stripe cancel failed (${sub.column}):`, err)
        reportError(err, { site: sub.site, orgId })
        return NextResponse.json(
          {
            error: 'Unable to cancel your subscription at this time. Please try again in a few minutes, or contact support at support@fieldstay.app if the issue persists.',
          },
          { status: 503 }
        )
      }
    }
    cleared[sub.column] = null
  }

  // Checkpoint the cancellations in one write (not one per subscription — see
  // the N+1 guardrail). A retry after a later-stage failure therefore skips
  // Stripe entirely; and if this write itself fails, isAlreadyCancelled()
  // above makes the re-attempted cancel a no-op rather than an error.
  const { error: clearError } = await admin
    .from('organizations')
    .update(cleared)
    .eq('id', orgId)

  if (clearError) {
    console.error(`[Account:${userId}] failed to clear cancelled subscription ids:`, clearError)
    reportError(clearError, { site: 'route.account.delete.stripe_cancel', orgId })
  }

  return null
}

/**
 * Delete the organization itself. The ON DELETE CASCADE from every
 * org-scoped table is what actually erases the tenant's data — properties,
 * bookings (guest_name/guest_email), owner_transactions, work_orders,
 * guidebook_guest_sms_optins, communication_logs and the rest. Deleting only
 * the auth user leaves ALL of it behind, unreachable by RLS and never
 * purged; that is exactly how the two orphaned orgs found in production on
 * 2026-07-30 (10 properties, 20 bookings carrying guest PII) came to exist.
 *
 * Idempotent: every statement is a DELETE by org_id, so a re-run after a
 * partial failure is a no-op for whatever already went.
 */
async function purgeOrganization(admin: Admin, orgId: string): Promise<NextResponse | null> {
  for (const table of ORG_TABLES_WITHOUT_CASCADE) {
    const { error } = await admin.from(table).delete().eq('org_id', orgId)
    if (error) {
      console.error(`[account/delete] failed to purge ${table} for org ${orgId}`, error)
      reportError(error, { site: 'route.account.delete.purge_org', orgId, extra: { table } })
      return NextResponse.json(
        { error: 'Failed to delete your organization data. Please try again.' },
        { status: 500 }
      )
    }
  }

  const { error } = await admin.from('organizations').delete().eq('id', orgId)
  if (error) {
    console.error(`[account/delete] failed to delete organization ${orgId}`, error)
    reportError(error, { site: 'route.account.delete.delete_org', orgId })
    return NextResponse.json(
      { error: 'Failed to delete your organization. Please try again.' },
      { status: 500 }
    )
  }

  return null
}

/** Revoke third-party tokens held in Vault. The LOOKUP failing must abort —
 *  proceeding would revoke nothing and leave live tokens behind forever,
 *  since the connection rows are about to be cascade-deleted. An individual
 *  revoke failing is reported but does not block: the token is already
 *  unusable without the account, and the alternative is a user who can never
 *  delete their account because one provider is down. */
async function revokeIntegrationTokens(
  admin: Admin,
  userId: string
): Promise<NextResponse | null> {
  const { data: connections, error } = await admin
    .from('integration_connections')
    .select('provider_id')
    .eq('user_id', userId)

  if (error) {
    console.error('[account/delete] integration_connections lookup failed', error)
    reportError(error, { site: 'route.account.delete.connection_lookup' })
    return NextResponse.json(
      { error: 'Unable to revoke your connected integrations right now. Please try again in a few minutes.' },
      { status: 503 }
    )
  }

  for (const conn of connections ?? []) {
    try {
      await revokeIntegrationToken(userId, conn.provider_id as string)
    } catch (err) {
      console.error(`[Account:${userId}] vault revoke failed for ${conn.provider_id}:`, err)
      reportError(err, {
        site:  'route.account.delete.vault_revoke',
        extra: { provider_id: conn.provider_id as string },
      })
    }
  }

  return null
}

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

  const body = await request.json().catch(() => null) as
    { confirm?: unknown; password?: unknown } | null

  if (body?.confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })
  }

  const password = typeof body.password === 'string' ? body.password : ''
  if (!password) {
    return NextResponse.json({ error: 'Password confirmation required' }, { status: 400 })
  }

  if (await isRateLimited(user.id)) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again in a few minutes.' },
      { status: 429 }
    )
  }

  if (!user.email || !(await passwordIsValid(user.email, password))) {
    return NextResponse.json({ error: 'Password is incorrect' }, { status: 401 })
  }

  const admin = createServiceClient({ authenticatedUser: user })

  // Every org membership — the user may belong to more than one.
  const { data: memberships, error: memberErr } = await admin
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)

  if (memberErr) {
    console.error('[account/delete] membership lookup', memberErr)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }

  const auditOrgIds: string[] = []
  const ownedOrgIds: string[] = []

  // Stage 1 — validate every owned org and cancel its billing. Nothing is
  // destroyed yet, so bailing out here leaves the account fully intact.
  for (const membership of memberships ?? []) {
    const orgId = membership.org_id as string
    auditOrgIds.push(orgId)

    if (membership.role !== 'owner') continue

    const blocked = await assertSoleMember(admin, orgId, user.id)
    if (blocked) return blocked

    const billingFailure = await cancelOrgSubscriptions(admin, orgId, user.id)
    if (billingFailure) return billingFailure

    ownedOrgIds.push(orgId)
  }

  // Stage 2 — audit BEFORE the data is gone. org_id in metadata as well as
  // the column, because audit_events.org_id is ON DELETE SET NULL and the
  // organizations row is about to disappear. An org id is not PII.
  await logAuditEvents(
    auditOrgIds.map((orgId) => ({
      orgId,
      actorId:  user.id,
      action:   'account.deleted' as const,
      metadata: { org_id: orgId },
    }))
  )

  // Stage 3 — revoke external tokens while the connection rows still exist.
  const revokeFailure = await revokeIntegrationTokens(admin, user.id)
  if (revokeFailure) return revokeFailure

  // Stage 4 — destroy the org data. Ordered before deleteUser so a failure
  // here leaves a still-usable account that can retry, rather than an
  // orphaned tenant nobody can reach.
  for (const orgId of ownedOrgIds) {
    const purgeFailure = await purgeOrganization(admin, orgId)
    if (purgeFailure) return purgeFailure
  }

  // Stage 5 — finally the auth user (cascades to profiles and any remaining
  // organization_members rows for orgs the user did not own).
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
  if (deleteError) {
    console.error(`[Account:${user.id}] deleteUser failed:`, deleteError.message)
    return NextResponse.json({ error: 'Failed to delete account. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
