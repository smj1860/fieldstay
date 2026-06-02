import { createServiceClient } from '@/lib/supabase/server'
import { AcceptForm }           from './accept-form'

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const admin = createServiceClient()

  const { data: invite } = await admin
    .from('org_invites')
    .select('id, email, role, expires_at, organizations(name)')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!invite) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4"
           style={{ background: '#102246' }}>
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-white mb-2">
            Invitation no longer valid
          </h1>
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
            This invitation has expired, been revoked, or already been accepted.
          </p>
          <a href="/login"
             className="inline-block mt-6 px-6 py-2.5 rounded-xl font-bold text-sm"
             style={{ background: '#FCD116', color: '#102246' }}>
            Go to Login
          </a>
        </div>
      </div>
    )
  }

  const orgData = Array.isArray(invite.organizations)
    ? invite.organizations[0]
    : invite.organizations
  const orgName = (orgData as { name?: string } | null)?.name ?? 'your team'

  return (
    <AcceptForm
      token={token}
      email={invite.email as string}
      orgName={orgName}
    />
  )
}
