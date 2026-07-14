'use client'

import { useActionState, useState } from 'react'
import { addCrewMember, completeCrewStep } from './actions'
import { Plus, CheckCircle2, PartyPopper } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { RequiredMark } from '@/components/ui/RequiredMark'

interface CrewMember {
  id: string; name: string; email: string | null
  phone: string | null; preferred_contact: string; specialty: string
}

export function CrewSetup({
  propertyId,
  crew,
}: {
  propertyId: string
  crew: CrewMember[]
}) {
  const [state, formAction, pending] = useActionState(addCrewMember, null)
  const [showForm, setShowForm] = useState(crew.length === 0)
  const [completing, setCompleting] = useState(false)

  // Close form on successful submission — compares against the previous
  // action state during render (rather than a useEffect) so the state
  // update lands in the same render pass as the state change itself.
  const [handledState, setHandledState] = useState(state)
  if (state !== handledState) {
    setHandledState(state)
    if (state?.success) setShowForm(false)
  }

  return (
    <div className="space-y-6">
      {/* Existing crew */}
      {crew.length > 0 && (
        <div className="space-y-2">
          <p className="section-header">{crew.length} crew member{crew.length !== 1 ? 's' : ''}</p>
          {crew.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 bg-canvas-themed rounded-lg border border-themed">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
              >
                {c.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-primary-themed">{c.name}</p>
                <p className="text-xs text-muted-themed">
                  {c.email ?? c.phone} · {c.preferred_contact}
                </p>
              </div>
              <span className="text-xs text-muted-themed capitalize">{c.specialty}</span>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="border border-themed rounded-xl p-5">
          <h3 className="text-sm font-semibold text-primary-themed mb-4">Add Crew Member</h3>

          {state?.error && (
            <div className="border text-sm rounded-lg px-3 py-2 mb-4" style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>{state.error}</div>
          )}
          {state?.success && (
            <div className="border text-sm rounded-lg px-3 py-2 mb-4 flex items-center gap-2" style={{ background: 'var(--accent-green-dim)', borderColor: 'var(--accent-green)', color: 'var(--accent-green)' }}>
              <CheckCircle2 className="w-4 h-4" /> Added successfully
            </div>
          )}

          <form action={formAction} className="space-y-4">
            <div>
              <label htmlFor="crew-name" className="label">Name <RequiredMark /></label>
              <Input id="crew-name" name="name" type="text" required placeholder="Full name" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="crew-email" className="label">Email</label>
                <Input id="crew-email" name="email" type="email" placeholder="crew@example.com" />
              </div>
              <div>
                <label htmlFor="crew-phone" className="label">Phone</label>
                <Input id="crew-phone" name="phone" type="tel" placeholder="(555) 000-0000" />
              </div>
            </div>
            <div>
              <label htmlFor="crew-preferred-contact" className="label">Preferred Contact</label>
              <select id="crew-preferred-contact" name="preferred_contact" className="input">
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={pending} className="text-sm">
                {pending ? 'Adding…' : 'Add Crew Member'}
              </Button>
              {crew.length > 0 && (
                <Button variant="ghost" type="button" onClick={() => setShowForm(false)} className="text-sm">Cancel</Button>
              )}
            </div>
          </form>
        </div>
      ) : crew.length > 0 ? (
        <div className="space-y-3">
          <Button onClick={() => setShowForm(true)} className="w-full justify-center">
            <Plus className="w-4 h-4" /> Add Another Crew Member
          </Button>
          <div className="rounded-lg p-4" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
            <p className="text-sm text-secondary-themed mb-1">
              Have a team? Upload a CSV with columns: name, email, phone, specialty
            </p>
            <a
              href="/crew-manage"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium"
              style={{ color: 'var(--accent-gold)' }}
            >
              Bulk import in Crew Manager →
            </a>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setShowForm(true)} className="w-full justify-center border-dashed">
          <Plus className="w-4 h-4" /> Add Crew Member
        </Button>
      )}

      {/* Finish setup */}
      <div className="border rounded-xl p-5" style={{ borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' }}>
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
          {crew.length > 0 ? <><PartyPopper className="w-4 h-4" /> Almost done!</> : 'Finish setup'}
        </h3>
        <p className="text-sm mb-4" style={{ color: 'var(--accent-green)' }}>
          {crew.length > 0
            ? 'Your property is set up and ready. FieldStay will sync your calendar and start creating turnovers.'
            : "You can add crew later. Click Finish to complete your property setup."
          }
        </p>
        <form action={async () => {
          setCompleting(true)
          await completeCrewStep(propertyId)
        }}>
          <Button type="submit" disabled={completing}>
            {completing ? 'Finishing…' : 'Finish Setup →'}
          </Button>
        </form>
      </div>
    </div>
  )
}
