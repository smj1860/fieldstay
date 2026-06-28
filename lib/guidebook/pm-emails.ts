import { createServiceClient } from '@/lib/supabase/server'

/**
 * Returns all PM (admin/owner) email addresses for an org plus the org name.
 *
 * Schema note: `profiles` has no `email` column — email lives on `auth.users`
 * only. Confirmed via:
 *   SELECT column_name, table_name FROM information_schema.columns
 *   WHERE column_name = 'email' AND table_schema = 'public';
 * which returns no rows for any public table. Resolution must go through
 * `auth.admin.getUserById`, same pattern as `lib/inngest/helpers.ts`.
 */
export async function getOrgPmEmails(orgId: string): Promise<{
  emails:  string[]
  orgName: string
}> {
  const supabase = createServiceClient()

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()

  const { data: members } = await supabase
    .from('organization_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin'])
    .not('user_id', 'is', null)
    .not('invite_accepted_at', 'is', null)

  if (!members?.length) return { emails: [], orgName: org?.name ?? '' }

  const emails = (
    await Promise.all(
      members.map(async (m) => {
        if (!m.user_id) return null
        const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id)
        return user?.email ?? null
      })
    )
  ).filter((e): e is string => Boolean(e))

  return { emails, orgName: org?.name ?? '' }
}
