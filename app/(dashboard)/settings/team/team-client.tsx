'use client'

import { useState, useTransition } from 'react'
import { Loader2, UserMinus, MailX } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { MemberRole } from '@/types/database'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { inviteTeamMember, removeMember, revokeInvite, type InvitableRole } from './actions'

/**
 * Display label + badge tone for EVERY member_role, not just the ones this
 * page can hand out.
 *
 * Totality is the point. The roster lists whatever rows the org actually has,
 * and an org can hold a 'manager' or 'viewer' from before the invite form
 * existed (or a 'crew' row written by another path). A partial map here reads
 * `undefined.tone` and throws inside a client component, which takes the whole
 * page to its error boundary rather than rendering one odd badge — so the
 * failure is total and looks nothing like its cause. That shipped for one
 * commit, hidden by a `role as 'owner' | 'admin' | 'finance'` cast in
 * page.tsx that told TypeScript a lie about what the column contains, and it
 * was caught by 30-role-separation.spec.ts's positive control. Keyed on
 * MemberRole so adding an enum label fails the BUILD next time.
 * unit/settings/team-role-meta.test.ts asserts the same thing against the
 * union, since a Record can still be satisfied by a wrong-but-present entry.
 */
const ROLE_META: Record<MemberRole, { label: string; tone: 'amber' | 'blue' | 'gold' | 'purple' | 'slate' }> = {
  owner:   { label: 'Owner',   tone: 'amber'  },
  admin:   { label: 'Admin',   tone: 'blue'   },
  finance: { label: 'Finance', tone: 'gold'   },
  manager: { label: 'Manager', tone: 'purple' },
  viewer:  { label: 'Viewer',  tone: 'slate'  },
  crew:    { label: 'Crew',    tone: 'slate'  },
}

const ROLE_OPTIONS: ReadonlyArray<{ value: InvitableRole; label: string; help: string }> = [
  {
    value: 'admin',
    label: 'Admin',
    help:  'Full operational access, plus billing, integrations and team management.',
  },
  {
    value: 'finance',
    label: 'Finance',
    help:  'Billing and vendor invoices only. No properties, turnovers, crew or settings.',
  },
]



interface Member {
  id:       string
  userId:   string
  email:    string
  role:     MemberRole
  joinedAt: string
}

interface Invite {
  id:        string
  email:     string
  role:      MemberRole
  createdAt: string
  expiresAt: string
}

interface Props {
  currentUserId:   string
  currentUserRole: MemberRole
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
              <Badge tone={ROLE_META[m.role].tone}>{ROLE_META[m.role].label}</Badge>
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
  const [role, setRole]         = useState<InvitableRole>('admin')
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [pending, startInvite]  = useTransition()

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    startInvite(async () => {
      const result = await inviteTeamMember(email, role)
      if (result.error) {
        setError(result.error)
      } else {
        setSuccess(true)
        setEmail('')
      }
    })
  }

  const selectedHelp = ROLE_OPTIONS.find((option) => option.value === role)?.help ?? ''

  return (
    <Card id="invite">
      <h2 className="text-base font-semibold text-primary-themed mb-1">Invite Team Member</h2>
      {/* The old copy here claimed admins "cannot manage billing or team
          members", which was never true of billing (createCheckoutSession and
          openBillingPortal are both requireOrgRole(['admin'])). Each role now
          describes itself from ROLE_OPTIONS instead of one sentence trying to
          describe all of them. */}
      <p className="text-sm text-muted-themed mb-4">{selectedHelp}</p>

      {success && (
        <div className="rounded-lg px-4 py-3 mb-4 text-sm"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)', border: '1px solid rgba(34,197,94,0.2)' }}>
          Invitation sent successfully.
        </div>
      )}

      <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          aria-label="Teammate email address"
          className="flex-1"
        />
        <label htmlFor="invite-role" className="sr-only">Role</label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as InvitableRole)}
          className="rounded-lg px-3 py-2 text-sm border-themed border bg-raised-themed
                     text-primary-themed flex-shrink-0
                     focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
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
