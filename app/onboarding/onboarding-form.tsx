'use client'

import { useActionState } from 'react'
import { createOrganization } from './actions'

interface OnboardingFormProps {
  userEmail: string
}

export function OnboardingForm({ userEmail }: OnboardingFormProps) {
  const [state, action, pending] = useActionState(createOrganization, null)

  return (
    <>
      <h2 className="text-xl font-bold text-accent-900 mb-1">Name your organization</h2>
      <p className="text-sm text-accent-500 mb-6">
        This is how your team and properties will be grouped. You can change it later.
      </p>

      <form action={action} className="space-y-4">
        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
            {state.error}
          </div>
        )}

        <div>
          <label htmlFor="org_name" className="label">Organization Name</label>
          <input
            id="org_name"
            name="org_name"
            type="text"
            required
            className="input"
            placeholder="e.g. Lakeview Property Group"
          />
          <p className="text-xs text-accent-400 mt-1">Signed in as {userEmail}</p>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="btn-primary w-full py-2.5"
        >
          {pending ? 'Setting up…' : 'Continue →'}
        </button>
      </form>
    </>
  )
}
