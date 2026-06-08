import type { createServiceClient } from '@/lib/supabase/server'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Resolve the org owner/admin email from an org_id.
 * Checks owner role first, falls back to admin.
 * Two-step: organization_members SELECT → auth.admin.getUserById.
 * Called by all notification-sending Inngest functions.
 */
export async function getPmEmail(
  supabase: ServiceClient,
  orgId: string
): Promise<string | null> {
  const { data: members } = await supabase
    .from('organization_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin'])

  if (!members?.length) return null

  const member = members.find(m => m.role === 'owner') ?? members[0]
  if (!member?.user_id) return null

  const { data: { user } } = await supabase.auth.admin.getUserById(member.user_id)
  return user?.email ?? null
}

/**
 * Batch-resolve PM emails for multiple orgs — avoids N×2 round-trips
 * inside cron functions that loop across all orgs.
 * Returns Map<orgId, email>.
 */
export async function getPmEmailsByOrgIds(
  supabase: ServiceClient,
  orgIds: string[]
): Promise<Map<string, string>> {
  if (!orgIds.length) return new Map()

  const { data: members } = await supabase
    .from('organization_members')
    .select('org_id, user_id, role')
    .in('org_id', orgIds)
    .in('role', ['owner', 'admin'])

  if (!members?.length) return new Map()

  // Keep one member per org — prefer owner over admin
  const bestByOrg = new Map<string, string>()
  for (const m of members) {
    if (!bestByOrg.has(m.org_id) || m.role === 'owner') {
      bestByOrg.set(m.org_id, m.user_id)
    }
  }

  const result = new Map<string, string>()
  await Promise.all(
    Array.from(bestByOrg.entries()).map(async ([org_id, user_id]) => {
      const { data: { user } } = await supabase.auth.admin.getUserById(user_id)
      if (user?.email) result.set(org_id, user.email)
    })
  )

  return result
}
