import { unwrap } from '@/lib/supabase/unwrap'
import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { AcceptInviteForm } from './accept-invite-form'
import { CheckCircle2, AlarmClock } from 'lucide-react'
import { buttonVariantClass } from '@/components/ui/Button'
import { crewInviteIsExpired } from '@/lib/crew/invite-expiry'
import { inviteViewThrottled } from '@/lib/auth/invite-view-throttle'

interface Props { params: Promise<{ token: string }> }

export default async function CrewInvitePage({ params }: Props) {
  const { token } = await params

  // Throttled BEFORE the lookup — see the note in
  // app/accept-invite/[token]/page.tsx. Same shape: a BYPASS_ROUTES entry
  // whose POST action is limited inline while the GET page answered "is this
  // token real?" at unbounded QPS.
  //
  // notFound() rather than a distinct throttle screen, matching the
  // invalid-token path exactly: a bot that can tell "rate limited" from "no
  // such token" has learned that the token it guessed was real.
  if (await inviteViewThrottled('page.crew-invite')) notFound()

  const supabase  = createServiceClient({ publicSurface: 'crew-invite--token-' })

  // A failed read fell into notFound(), telling the crew member their invite
  // link is dead when it is not.
  const crewRes = await supabase
    .from('crew_members')
    .select('id, name, email, invite_sent_at, invite_accepted_at, user_id, created_at')
    .eq('invite_token', token)
    .maybeSingle()

  const crew = unwrap(crewRes, { site: 'page.crew-invite' })
  if (!crew) notFound()

  if (crew.user_id || crew.invite_accepted_at) {
    return (
      <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
        <div className="bg-card-themed rounded-2xl p-8 max-w-md w-full text-center">
          <CheckCircle2 className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--accent-green)' }} />
          <h2 className="text-lg font-bold text-primary-themed mb-2">Account Already Active</h2>
          <p className="text-sm text-muted-themed mb-6">
            Your FieldStay account is set up. Log in to see your assignments.
          </p>
          <a href="/crew/login" className={buttonVariantClass('primary') + ' w-full block text-center py-2.5'}>
            Go to Login →
          </a>
        </div>
      </div>
    )
  }

  // Shared with the Server Action, deliberately — this page used to run its
  // own copy of the rule, and only `if (crew.invite_sent_at)` at that, so a row
  // with a NULL invite_sent_at rendered a working activation form no matter how
  // old it was. The action hardened its copy (fall back to created_at) because
  // a permanently-valid token mints a real auth account; the page never
  // followed. Not exploitable — the action is the gate and refuses it — but the
  // crew member filled in a password form before being told the link was dead,
  // and that was 5 of the 8 invites pending in production on 2026-08-06.
  if (crewInviteIsExpired(crew.invite_sent_at, crew.created_at)) {
    return (
      <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
        <div className="bg-card-themed rounded-2xl p-8 max-w-md w-full text-center">
          <AlarmClock className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--accent-amber)' }} />
          <h2 className="text-lg font-bold text-primary-themed mb-2">Invite Link Expired</h2>
          <p className="text-sm text-muted-themed">
            This link has expired. Ask your property manager to send a new invite.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black text-white tracking-tight">FieldStay</h1>
          <p className="text-brand-200 text-sm mt-1">Crew App</p>
        </div>
        <div className="bg-card-themed rounded-2xl shadow-lg p-8">
          <h2 className="text-xl font-bold text-primary-themed mb-1">Welcome, {crew.name}</h2>
          <p className="text-sm text-muted-themed mb-6">
            Create a password to activate your account.
          </p>
          <AcceptInviteForm
            token={token}
            crewId={crew.id}
            email={crew.email ?? ''}
          />
        </div>
      </div>
    </div>
  )
}
