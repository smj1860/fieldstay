'use client'

import { useState, useTransition } from 'react'
import { Loader2, UserMinus, MailX } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { inviteTeamMember, removeMember, revokeInvite } from './actions'

interface Member {
  id:       string
  userId:   string
  email:    string
  role:     'owner' | 'admin'
  joinedAt: string
}

interface Invite {
  id:        string
  email:     string
  role:      'admin'
  createdAt: string
  expiresAt: string
}

interface Props {
  currentUserId:   string
  currentUserRole: 'owner' | 'admin'
  members:         Member[]
  invites:         Invite[]
}

export function TeamClient({ currentUserId, currentUserRole, members, invites }: Props) {
  const isOwner = currentUserRole === 'owner'

  return (
    <div className="space-y-8 max-w-2xl">
      <MembersSection
        members={members}
        currentUserId={currentUserId}
        isOwner={isOwner}
      />
      {isOwner && (
        <>
          <InviteSection />
          <PendingInvitesSection invites={invites} />
        </>
      )}
    </div>
  )
}

// ── Members table ─────────────────────────────────────────────────────────────

function MembersSection({
  members, currentUserId, isOwner,
}: Readonly<{
  members: Member[]
  currentUserId: string
  isOwner: boolean
}>) {
  const [removing, startRemove] = useTransition()
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRemove = (userId: string) => {
    setRemovingId(userId)
    setError(null)
    startRemove(async () => {
      const result = await removeMember(userId)
      if (result.error) setError(result.error)
      setRemovingId(null)
    })
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-primary-themed mb-4">
        Members ({members.length})
      </h2>

      {error && (
        <p className="text-sm mb-4" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      <div className="divide-y divide-themed">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between py-3 gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary-themed truncate">{m.email}</p>
              <p className="text-xs text-muted-themed mt-0.5">Joined {formatDate(m.joinedAt)}</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <Badge tone={m.role === 'owner' ? 'amber' : 'blue'}>
                {m.role === 'owner' ? 'Owner' : 'Admin'}
              </Badge>
              {isOwner && m.role !== 'owner' && m.userId !== currentUserId && (
                <Button
                  variant="ghost"
                  onClick={() => handleRemove(m.userId)}
                  disabled={removing && removingId === m.userId}
                  className="text-xs py-1 px-2 flex items-center gap-1"
                  style={{ color: 'var(--accent-red)' }}
                  title="Remove member"
                >
                  {removing && removingId === m.userId
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <UserMinus className="w-3 h-3" />
                  }
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Invite section ────────────────────────────────────────────────────────────

function InviteSection() {
  const [email, setEmail]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [pending, startInvite]  = useTransition()

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    startInvite(async () => {
      const result = await inviteTeamMember(email)
      if (result.error) {
        setError(result.error)
      } else {
        setSuccess(true)
        setEmail('')
      }
    })
  }

  return (
    <Card id="invite">
      <h2 className="text-base font-semibold text-primary-themed mb-1">Invite Team Member</h2>
      <p className="text-sm text-muted-themed mb-4">
        Admins have full operational access but cannot manage billing or team members.
      </p>

      {success && (
        <div className="rounded-lg px-4 py-3 mb-4 text-sm"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}>
          Invitation sent successfully.
        </div>
      )}

      <form onSubmit={handleInvite} className="flex gap-3">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="flex-1"
        />
        <Button type="submit" disabled={pending} className="flex-shrink-0">
          {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send Invite'}
        </Button>
      </form>

      {error && (
        <p className="text-sm mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}
    </Card>
  )
}

// ── Pending invites ───────────────────────────────────────────────────────────

function PendingInvitesSection({ invites }: Readonly<{ invites: Invite[] }>) {
  const [revoking, startRevoke]   = useTransition()
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)

  const handleRevoke = (id: string) => {
    setRevokingId(id)
    setError(null)
    startRevoke(async () => {
      const result = await revokeInvite(id)
      if (result.error) setError(result.error)
      setRevokingId(null)
    })
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-primary-themed mb-4">
        Pending Invitations
      </h2>

      {error && (
        <p className="text-sm mb-4" style={{ color: 'var(--accent-red)' }}>{error}</p>
      )}

      {invites.length === 0 ? (
        <p className="text-sm text-muted-themed">No pending invitations.</p>
      ) : (
        <div className="divide-y divide-themed">
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between py-3 gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary-themed truncate">{inv.email}</p>
                <p className="text-xs text-muted-themed mt-0.5">
                  Sent {formatDate(inv.createdAt)} · Expires {formatDate(inv.expiresAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={() => handleRevoke(inv.id)}
                disabled={revoking && revokingId === inv.id}
                className="text-xs py-1 px-2 flex items-center gap-1 flex-shrink-0"
                style={{ color: 'var(--accent-red)' }}
              >
                {revoking && revokingId === inv.id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <MailX className="w-3 h-3" />
                }
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
