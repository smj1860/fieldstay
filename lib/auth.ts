import { createClient, createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import type { MemberRole } from '@/types/database'
import { logAuditEvent } from '@/lib/audit'

export interface OrgMembership {
  org_id: string
  role: MemberRole
  org: {
    name: string
    plan: string
    plan_status: string
    max_properties: number
    trial_ends_at: string | null
  }
}

/**
 * Verify the current user is authenticated.
 * Redirects to /login if not.
 */
export async function requireAuth() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: row } = await supabase
    .from('organization_members')
    .select(`
      org_id, role,
      organizations ( name, plan, plan_status, max_properties, trial_ends_at )
    `)
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!row) redirect('/onboarding')

  const orgData = Array.isArray(row.organizations)
    ? row.organizations[0]
    : row.organizations

  const membership: OrgMembership = {
    org_id: row.org_id,
    role:   row.role as MemberRole,
    org: {
      name:           orgData?.name ?? '',
      plan:           orgData?.plan ?? 'starter',
      plan_status:    orgData?.plan_status ?? 'trialing',
      max_properties: orgData?.max_properties ?? 5,
      trial_ends_at:  orgData?.trial_ends_at ?? null,
    },
  }

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
  const admin = createServiceClient()
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
