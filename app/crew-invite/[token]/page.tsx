import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { AcceptInviteForm } from './accept-invite-form'
import { CheckCircle2, AlarmClock } from 'lucide-react'

interface Props { params: Promise<{ token: string }> }

// Plain helper, not a component — keeps the Date.now() call out of the
// page component's own body (react-hooks/purity flags impure calls inside
// anything it identifies as a component/hook; this is a one-shot
// server-rendered check, not something subject to re-render concerns).
function isInviteExpired(sentAt: string, ttlDays: number): boolean {
  return new Date(sentAt).getTime() + ttlDays * 86_400_000 < Date.now()
}

export default async function CrewInvitePage({ params }: Props) {
  const { token } = await params
  const supabase  = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_sent_at, invite_accepted_at, user_id')
    .eq('invite_token', token)
    .single()

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
          <a href="/crew/login" className="btn-primary w-full block text-center py-2.5">
            Go to Login →
          </a>
        </div>
      </div>
    )
  }

  if (crew.invite_sent_at) {
    const expired = isInviteExpired(crew.invite_sent_at, 7)
    if (expired) {
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
  }

  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">FieldStay</h1>
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
            name={crew.name}
          />
        </div>
      </div>
    </div>
  )
}
