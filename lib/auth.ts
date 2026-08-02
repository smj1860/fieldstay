import { cache } from 'react'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import type { MemberRole } from '@/types/database'
import { logAuditEvent } from '@/lib/audit'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { reportError } from '@/lib/observability/report-error'
import { setActorContext, setTenantContext } from '@/lib/observability/sentry-context'

export interface OrgMembership {
  org_id: string
  role: MemberRole
  org: {
    name: string
    plan: string
    plan_status: string
    max_properties: number
    trial_ends_at: string | null
    repuguard_status: 'inactive' | 'trial' | 'active' | 'cancelled'
    onboarding_steps_completed: Record<string, boolean>
  }
}

/**
 * Request-memoized auth lookup. requireAuth/requireOrgMember are called by
 * the dashboard layout AND again by nearly every page/action in the same
 * request — without memoization each call re-runs auth.getUser() plus the
 * organization_members query. cache() dedupes them to one execution per
 * request during an RSC render (outside a render it degrades to a plain
 * call, so Server Actions and tests behave as before).
 *
 * redirect() stays OUT of these cached functions: it throws a control-flow
 * error, and caching a rejected promise would replay a stale redirect if a
 * later caller in the same request could handle the null differently.
 */
const getAuthContext = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Attach the actor to this request's Sentry scope. Every issue previously
  // reported "Users: 0" because nothing ever set one, so impact was invisible.
  // UUID only — see setActorContext for why email is deliberately excluded.
  if (user) setActorContext(user.id)

  return { supabase, user }
})

const getMembershipContext = cache(async () => {
  const { supabase, user } = await getAuthContext()
  if (!user) return { supabase, user, membership: null }

  // organization_members is a many-to-many join table, so a user CAN hold more
  // than one accepted membership — anyone managing properties under two legal
  // entities, an agency serving multiple clients, or any account merge.
  //
  // This used to be .single(), which returns a PGRST116 error rather than a row
  // as soon as a second accepted membership exists. The error was discarded
  // (only `data` was destructured), so the user fell through to membership:null
  // and requireOrgMember() redirected them to /onboarding — locked out of BOTH
  // orgs, silently, with nothing thrown to explain it.
  //
  // Ordering by invite_accepted_at makes the choice deterministic (oldest
  // membership wins) instead of leaving it to Postgres row order, so a
  // single-org user's behaviour is byte-identical to before. There is no org
  // switcher yet: a genuine multi-org user lands in their oldest org and cannot
  // reach the others. That is strictly better than being locked out of all of
  // them, but it is an interim state — the real fix needs a persisted
  // active-org selection and a switcher in the layout.
  const { data: rows, error } = await supabase
    .from('organization_members')
    .select(`
      org_id, role, invite_accepted_at,
      organizations ( name, plan, plan_status, max_properties, trial_ends_at, repuguard_status, onboarding_steps_completed )
    `)
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .order('invite_accepted_at', { ascending: true })

  if (error) {
    // Distinguish a real query failure from "this user has no memberships" —
    // both used to collapse into the same silent redirect to /onboarding.
    reportError(error, { site: 'lib.auth.getMembershipContext' })
    return { supabase, user, membership: null }
  }

  if (!rows || rows.length === 0) return { supabase, user, membership: null }

  if (rows.length > 1) {
    // Not an error, but we have no UI for it yet and the user is silently
    // confined to one org. Surfacing it means we find out from Sentry rather
    // than from a support ticket.
    reportError(
      new Error('User holds multiple accepted org memberships; no org switcher exists yet'),
      {
        site:  'lib.auth.getMembershipContext',
        orgId: rows[0]!.org_id,
        extra: { membership_count: rows.length },
      },
    )
  }

  const row = rows[0]!

  const orgData = unwrapJoin(row.organizations)

  // Tag the request with its tenant so "is this one org or all of them" is
  // answerable from the Sentry issue list, without opening an event.
  setTenantContext({
    orgId: row.org_id,
    role:  row.role as string,
    plan:  orgData?.plan ?? undefined,
  })

  const membership: OrgMembership = {
    org_id: row.org_id,
    role:   row.role as MemberRole,
    org: {
      name:           orgData?.name ?? '',
      plan:           orgData?.plan ?? 'starter',
      plan_status:    orgData?.plan_status ?? 'trialing',
      max_properties: orgData?.max_properties ?? 5,
      trial_ends_at:  orgData?.trial_ends_at ?? null,
      repuguard_status: orgData?.repuguard_status ?? 'inactive',
      onboarding_steps_completed:
        (orgData?.onboarding_steps_completed ?? {}) as Record<string, boolean>,
    },
  }

  return { supabase, user, membership }
})

/**
 * Verify the current user is authenticated.
 * Redirects to /login if not.
 */
export async function requireAuth() {
  const { supabase, user } = await getAuthContext()
  if (!user) redirect('/login')
  return { user, supabase }
}

/**
 * Verify the current user is an authenticated org member.
 * Redirects to /login or /onboarding if not.
 */
export async function requireOrgMember(): Promise<
  ReturnType<typeof requireAuth> extends Promise<infer T>
    ? T & { membership: OrgMembership }
    : never
> {
  const { supabase, user, membership } = await getMembershipContext()
  if (!user) redirect('/login')
  if (!membership) redirect('/onboarding')

  return { user, supabase, membership } as never
}

/**
 * Verify the current user is an org member with one of the given roles.
 * Mirrors the DB-layer is_org_member() semantics: 'owner' always passes,
 * regardless of the allowedRoles array. Throws (rather than redirecting)
 * on a role mismatch, since a Server Action has no page to redirect to —
 * existing try/catch blocks in mutating actions already convert this into
 * a generic { error } result the same way they handle any other failure.
 */
export async function requireOrgRole(allowedRoles: MemberRole[]) {
  const result = await requireOrgMember()
  const { role } = result.membership

  if (role !== 'owner' && !allowedRoles.includes(role)) {
    throw new Error('You do not have permission to perform this action.')
  }

  return result
}

/**
 * Return the current user's role in their org.
 * Used to gate owner-only UI in settings pages.
 */
export async function getOrgMembership(userId: string, orgId: string) {
  const admin = createServiceClient({ system: 'lib/auth' })
  const { data } = await admin
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .single()
  return data ?? null
}

/**
 * Verify the current user is a FieldStay platform admin (platform_staff
 * with role = 'admin') — independent of any organization_members role,
 * since a platform admin isn't necessarily a member of any given org.
 * Redirects to /ops rather than a 404/403 page, so the admin panel's
 * existence isn't signalled to a logged-in non-admin who guesses the URL.
 */
export async function requirePlatformAdmin() {
  const { user, supabase } = await requireAuth()

  const { data } = await supabase.rpc('is_platform_staff_admin')
  if (!data) {
    await logAuditEvent({
      actorId:    user.id,
      action:     'security.route.mismatch',
      targetType: 'route',
      targetId:   '/admin',
      metadata:   { reason: 'non_platform_admin_reached_admin_app' },
    })
    redirect('/ops')
  }

  return { user, supabase }
}

/**
 * Verify a property belongs to the user's org.
 * Returns the property or redirects to /properties if not found.
 */
export async function requireProperty(propertyId: string) {
  const { user, supabase, membership } = await requireOrgMember()

  const { data: property } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) redirect('/properties')

  return { user, supabase, membership, property }
}

/**
 * Delete an auth user that was just created and then turned out to belong to
 * nothing — an invite claimed by someone else mid-flight, or a failed link.
 *
 * Exists because the three call sites that do this all discarded the result:
 *
 *   await supabase.auth.admin.deleteUser(authData.user.id)
 *
 * Those cleanup branches exist SPECIFICALLY to prevent an orphaned auth user —
 * an account that can log in, fails every requireCrewMember()/requireOrgMember()
 * check with nothing explaining why, and shows up nowhere on the PM side. If
 * the delete itself fails (a transient admin-API error, a network blip), the
 * orphan is created anyway and nobody finds out, because nothing inspected the
 * error. The failure mode the branch was written to prevent, arriving silently
 * through the branch that prevents it.
 *
 * Nothing here can undo a failed delete — the point is that it becomes VISIBLE
 * (console + Sentry, tagged by call site) so an operator can clean it up. The
 * user id is a UUID, not PII, so it is safe in Sentry `extra` per the logging
 * rules.
 *
 * NEVER THROWS, deliberately. Every caller is already on its own error path,
 * about to return a specific message ('This invite has already been used').
 * gotrue normally reports failure in `{ error }`, but a network-level fault
 * throws — and letting that propagate would replace the caller's precise
 * message with a generic crash, on top of the orphan. The cleanup failing must
 * not also destroy the explanation the user was about to get.
 *
 * Returns true when the account is gone, false when an orphan is now live.
 */
export async function deleteOrphanedAuthUser(
  admin:  { auth: { admin: { deleteUser: (id: string) => Promise<{ error: unknown }> } } },
  userId: string,
  site:   string,
): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (!error) return true

    console.error('[deleteOrphanedAuthUser] cleanup failed — orphaned auth user', { site, userId })
    reportError(error, { site, extra: { userId, orphaned: true } })
    return false
  } catch (err) {
    console.error('[deleteOrphanedAuthUser] cleanup threw — orphaned auth user', { site, userId })
    reportError(err, { site, extra: { userId, orphaned: true, threw: true } })
    return false
  }
}
