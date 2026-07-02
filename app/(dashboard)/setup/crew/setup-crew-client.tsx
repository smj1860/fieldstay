'use client'

import { useState, useActionState } from 'react'
import { Plus, Check } from 'lucide-react'
import {
  addCrewMember,
  inviteCrewMember,
  type SettingsActionState,
} from '@/app/(dashboard)/settings/actions'

interface CrewPreview {
  id: string; name: string; role: string | null; specialty: string | null
  email: string | null; invite_sent_at: string | null; user_id: string | null
}

interface Props {
  crew:           CrewPreview[]
  continueAction: () => Promise<void>
}

export function SetupCrewStep({ crew: initialCrew, continueAction }: Props) {
  const [crew, setCrew] = useState(initialCrew)
  const [view, setView] = useState<'list' | 'add'>('list')
  const [savedName, setSavedName] = useState<string | null>(null)
  const [state, formAction, pending] = useActionState(
    async (prev: SettingsActionState | null, fd: FormData) => {
      const res = await addCrewMember(prev, fd)
      if (res.success) {
        if (res.crewMember) {
          setCrew((prev) => [...prev, res.crewMember!])
        }
        setView('list')
        setSavedName((fd.get('name') as string)?.trim() || 'Crew member')
        setTimeout(() => setSavedName(null), 4000)
      }
      return res
    },
    null
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Add Your Crew
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Add cleaning and maintenance team members. Invite them to the crew app after adding.
          These team members belong to your organization and can be assigned to any property —
          you'll choose who works which turnover as bookings come in.
        </p>
      </div>

      {savedName && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm"
             style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}>
          <Check className="w-4 h-4 flex-shrink-0" />
          {savedName} saved successfully
        </div>
      )}

      {crew.length > 0 && (
        <div className="border border-themed rounded-xl overflow-hidden">
          {crew.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-4 py-2.5 border-b border-themed last:border-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                     style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}>
                  {m.name[0]?.toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-medium text-primary-themed">{m.name}</div>
                  <div className="text-xs text-muted-themed capitalize">{m.role} · {m.specialty}</div>
                </div>
              </div>
              <InviteChip memberId={m.id} inviteSentAt={m.invite_sent_at} hasApp={!!m.user_id} />
            </div>
          ))}
        </div>
      )}

      {view === 'add' ? (
        <div className="p-4 rounded-xl border border-themed" style={{ background: 'var(--bg-canvas)' }}>
          <p className="text-sm font-semibold text-secondary-themed mb-3">New Crew Member</p>
          {state?.error && (
            <div className="text-sm rounded-lg px-3 py-2 mb-3"
                 style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
              {state.error}
            </div>
          )}
          <form action={formAction} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="crew-name" className="label">Name *</label>
                <input id="crew-name" name="name" type="text" required className="input" placeholder="Alex Johnson" />
              </div>
              <div>
                <label htmlFor="crew-role" className="label">Role</label>
                <select id="crew-role" name="role" className="input" defaultValue="general">
                  <option value="cleaning">Cleaning</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="landscaping">Landscaping</option>
                  <option value="general">General</option>
                </select>
              </div>
              <div>
                <label htmlFor="crew-email" className="label">Email *</label>
                <input id="crew-email" name="email" type="email" required className="input" placeholder="alex@example.com" />
              </div>
              <div>
                <label htmlFor="crew-phone" className="label">Phone</label>
                <input id="crew-phone" name="phone" type="tel" className="input" placeholder="+1 555-0100" />
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Adding…' : 'Add Member'}
              </button>
              <button type="button" onClick={() => setView('list')} className="btn-ghost text-sm">
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <button onClick={() => setView('add')} className="btn-secondary text-sm flex items-center gap-2 w-full justify-center">
          <Plus className="w-4 h-4" />
          {crew.length === 0 ? 'Add First Crew Member' : 'Add Another'}
        </button>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-themed">
        <form action={continueAction}>
          <button type="submit" className="btn-primary">
            {crew.length > 0 ? 'Continue →' : 'Skip for now →'}
          </button>
        </form>
      </div>
    </div>
  )
}

function InviteChip({
  memberId, inviteSentAt, hasApp,
}: { memberId: string; inviteSentAt: string | null; hasApp: boolean }) {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  if (hasApp) return <span className="badge badge-green text-xs">In App</span>
  if (sent)   return <span className="text-xs" style={{ color: 'var(--accent-green)' }}>✓ Invited</span>

  return (
    <button onClick={async () => { setBusy(true); await inviteCrewMember(memberId); setBusy(false); setSent(true) }}
            disabled={busy} className="btn-secondary text-xs py-1 px-2.5">
      {busy ? 'Sending…' : inviteSentAt ? 'Resend Invite' : 'Invite to App'}
    </button>
  )
}
