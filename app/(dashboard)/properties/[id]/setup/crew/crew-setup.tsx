'use client'

import { useActionState, useState } from 'react'
import { addCrewMember, completeCrewStep } from './actions'
import { Plus, User, CheckCircle2 } from 'lucide-react'

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

  return (
    <div className="space-y-6">
      {/* Existing crew */}
      {crew.length > 0 && (
        <div className="space-y-2">
          <p className="section-header">{crew.length} crew member{crew.length !== 1 ? 's' : ''}</p>
          {crew.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 bg-accent-50 rounded-lg border border-accent-100">
              <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-bold flex-shrink-0">
                {c.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-accent-800">{c.name}</p>
                <p className="text-xs text-accent-400">
                  {c.email ?? c.phone} · {c.preferred_contact}
                </p>
              </div>
              <span className="text-xs text-accent-400 capitalize">{c.specialty}</span>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="border border-accent-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-accent-700 mb-4">Add Crew Member</h3>

          {state?.error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{state.error}</div>
          )}
          {state?.success && (
            <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-3 py-2 mb-4 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Added successfully
            </div>
          )}

          <form action={async (fd) => {
            await formAction(fd)
            if (!state?.error) setShowForm(false)
          }} className="space-y-4">
            <div>
              <label className="label">Name <span className="text-red-500">*</span></label>
              <input name="name" type="text" required className="input" placeholder="Full name" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Email</label>
                <input name="email" type="email" className="input" placeholder="crew@example.com" />
              </div>
              <div>
                <label className="label">Phone</label>
                <input name="phone" type="tel" className="input" placeholder="(555) 000-0000" />
              </div>
            </div>
            <div>
              <label className="label">Preferred Contact</label>
              <select name="preferred_contact" className="input">
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Adding…' : 'Add Crew Member'}
              </button>
              {crew.length > 0 && (
                <button type="button" onClick={() => setShowForm(false)} className="btn-ghost text-sm">Cancel</button>
              )}
            </div>
          </form>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="btn-secondary w-full justify-center border-dashed">
          <Plus className="w-4 h-4" /> Add Crew Member
        </button>
      )}

      {/* Finish setup */}
      <div className="border border-green-200 bg-green-50 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-green-800 mb-1">
          {crew.length > 0 ? '🎉 Almost done!' : 'Finish setup'}
        </h3>
        <p className="text-sm text-green-700 mb-4">
          {crew.length > 0
            ? 'Your property is set up and ready. FieldStay will sync your calendar and start creating turnovers.'
            : "You can add crew later. Click Finish to complete your property setup."
          }
        </p>
        <form action={async () => {
          setCompleting(true)
          await completeCrewStep(propertyId)
        }}>
          <button type="submit" disabled={completing} className="btn-primary">
            {completing ? 'Finishing…' : 'Finish Setup →'}
          </button>
        </form>
      </div>
    </div>
  )
}
