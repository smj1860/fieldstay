import { unwrap } from '@/lib/supabase/unwrap'
import { createServiceClient } from '@/lib/supabase/server'
import { AcceptForm }           from './accept-form'
import { AlertTriangle }        from 'lucide-react'
import { unwrapJoin }           from '@/lib/utils/supabase-joins'
import { inviteViewThrottled }  from '@/lib/auth/invite-view-throttle'

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Throttled BEFORE the lookup, not after. This page is a
  // BYPASS_ROUTES entry, so it gets no limiter from
  // rateLimiterForPathname() — and the inline limiter that was added for this
  // flow guards only the POST action. A token-guessing bot never needs to
  // reach that action: rendering this page already answers "is this token
  // real?", at unbounded QPS. Checking after the query would leave the
  // enumeration signal intact and merely hide the HTML.
  if (await inviteViewThrottled('page.accept-invite')) {
    return <InviteUnavailable
      heading="Too many attempts"
      body="Please wait a few minutes and open your invitation link again."
    />
  }

  const admin = createServiceClient({ publicSurface: 'accept-invite--token-' })

  // A failed read rendered the "invalid or expired invite" state, which sends
  // the invitee chasing a link that is actually fine.
  const inviteRes = await admin
    .from('org_invites')
    .select('id, email, role, expires_at, organizations(name)')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  const invite = unwrap(inviteRes, { site: 'page.accept-invite' })

  if (!invite) {
    return <InviteUnavailable
      heading="Invitation no longer valid"
      body="This invitation has expired, been revoked, or already been accepted."
    />
  }

  const orgData = unwrapJoin(invite.organizations)
  const orgName = (orgData as { name?: string } | null)?.name ?? 'your team'

  return (
    <AcceptForm
      token={token}
      email={invite.email as string}
      orgName={orgName}
    />
  )
}

/**
 * The one "you cannot proceed" screen, shared by the throttled and the
 * invalid-invite paths.
 *
 * Deliberately the SAME layout for both, with only the copy differing: a
 * visibly distinct throttle page would tell an enumerating bot that it had
 * found a real token and merely hit a limit, which is exactly the signal the
 * throttle exists to withhold.
 */
function InviteUnavailable({ heading, body }: Readonly<{ heading: string; body: string }>) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: '#102246' }}>
      <div className="text-center max-w-sm">
        <div className="flex justify-center mb-4">
          <AlertTriangle className="w-12 h-12" style={{ color: '#FCD116' }} />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">{heading}</h1>
        <p className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>{body}</p>
        <a href="/login"
           className="inline-block mt-6 px-6 py-2.5 rounded-xl font-bold text-sm"
           style={{ background: '#FCD116', color: '#102246' }}>
          Go to Login
        </a>
      </div>
    </div>
  )
}
