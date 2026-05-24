import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import type { MemberRole } from '@/types/database'

export interface OrgMembership {
  org_id: string
  role: MemberRole
  org: {
    name: string
    plan: string
    plan_status: string
    max_properties: number
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
      organizations ( name, plan, plan_status, max_properties )
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
    },
  }

  return { user, supabase, membership } as never
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
