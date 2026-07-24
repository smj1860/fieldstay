import type { Metadata }      from 'next'
import Link                    from 'next/link'
import { requireOrgMember }    from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { TeamClient }          from './team-client'
import { buttonVariantClass }  from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Team — FieldStay' }

export default async function TeamPage() {
  const { user, membership } = await requireOrgMember()
  const admin = createServiceClient({ authorizedBy: membership })

  // Fetch all members with their auth emails
  const { data: members } = await admin
    .from('organization_members')
    .select('id, user_id, role, created_at')
    .eq('org_id', membership.org_id)
    .order('created_at', { ascending: true })

  // Fetch auth user emails for all members
  const memberEmails: Record<string, string> = {}
  if (members?.length) {
    const { data: authUsers } = await admin.auth.admin.listUsers()
    for (const u of authUsers?.users ?? []) {
      memberEmails[u.id] = u.email ?? ''
    }
  }

  // Fetch pending invites
  const { data: invites } = await admin
    .from('org_invites')
    .select('id, email, role, created_at, expires_at')
    .eq('org_id', membership.org_id)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })

  const memberRows = (members ?? []).map((m) => ({
    id:        m.id as string,
    userId:    m.user_id as string,
    email:     memberEmails[m.user_id as string] ?? '',
    role:      m.role as 'owner' | 'admin',
    joinedAt:  m.created_at as string,
  }))

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Link href="/settings" className="text-sm text-muted-themed hover:text-secondary-themed">
          Settings
        </Link>
        <span className="text-muted-themed">/</span>
        <span className="text-sm text-secondary-themed">Team</span>
      </div>

      <div className="page-header mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">
            Manage who has access to your FieldStay organization.
          </p>
        </div>
        {membership.role === 'owner' && (
          <a
            href="#invite"
            className={buttonVariantClass('primary') + ' text-sm flex-shrink-0 flex items-center gap-1.5'}
          >
            Invite Member
          </a>
        )}
      </div>

      <TeamClient
        currentUserId={user.id}
        currentUserRole={membership.role as 'owner' | 'admin'}
        members={memberRows}
        invites={(invites ?? []).map((i) => ({
          id:        i.id as string,
          email:     i.email as string,
          role:      i.role as 'admin',
          createdAt: i.created_at as string,
          expiresAt: i.expires_at as string,
        }))}
      />
    </div>
  )
}
