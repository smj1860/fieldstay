'use client'

import { useActionState } from 'react'
import { activateCrewAccount } from './actions'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export function AcceptInviteForm({
  token,
  crewId,
  email,
}: {
  token:  string
  crewId: string
  email:  string
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      return activateCrewAccount(formData)
    },
    null
  )

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token"  value={token}  />
      <input type="hidden" name="crewId" value={crewId} />

      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {state.error}
        </div>
      )}

      <div>
        <label htmlFor="email" className="label">Email</label>
        <Input
          id="email"
          type="email"
          value={email}
          disabled
          className="bg-raised-themed text-muted-themed cursor-not-allowed"
        />
      </div>

      <div>
        <label htmlFor="password" className="label">
          Password <span className="text-red-500">*</span>
        </label>
        <Input
          id="password"
          type="password"
          name="password"
          required
          minLength={8}
          maxLength={72}
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
      </div>

      <div>
        <label htmlFor="confirm-password" className="label">
          Confirm Password <span className="text-red-500">*</span>
        </label>
        <Input
          id="confirm-password"
          type="password"
          name="confirm"
          required
          placeholder="Repeat password"
          autoComplete="new-password"
        />
      </div>

      <Button
        variant="cta"
        type="submit"
        disabled={pending}
        className="w-full py-2.5 disabled:opacity-60"
      >
        {pending ? 'Creating account…' : 'Activate Account →'}
      </Button>

      <p className="text-xs text-center text-muted">
        You&apos;ll be taken directly to the FieldStay crew app after activating.
      </p>
    </form>
  )
}
