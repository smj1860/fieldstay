'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { acceptTeamInvite } from './actions'
import { Input } from '@/components/ui/Input'

interface Props {
  token:   string
  email:   string
  orgName: string
}

export function AcceptForm({ token, email, orgName }: Props) {
  const [state, formAction, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      return acceptTeamInvite(formData)
    },
    null
  )

  const loginUrl = `/login?invite_token=${encodeURIComponent(token)}`

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: '#102246', fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <span className="text-2xl font-black" style={{ color: '#fff' }}>
            Field<span style={{ color: '#FCD116' }}>Stay</span>
          </span>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-8"
             style={{ background: '#fff', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>

          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                 style={{ background: 'rgba(16,34,70,0.08)' }}>
              <Mail className="w-5 h-5" style={{ color: '#102246' }} />
            </div>
            <h1 className="text-xl font-black tracking-tight mb-1"
                style={{ color: '#111827', letterSpacing: '-0.5px' }}>
              You've been invited
            </h1>
            <p className="text-sm" style={{ color: '#6B7280' }}>
              Join <strong style={{ color: '#111827' }}>{orgName}</strong> on FieldStay
            </p>
          </div>

          <form action={formAction} className="space-y-4">
            <input type="hidden" name="token" value={token} />

            {state?.error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
                {state.error}
              </div>
            )}

            <div>
              <label htmlFor="invite-email" className="label">Email</label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                disabled
                className="bg-accent-50 text-accent-500 cursor-not-allowed"
              />
            </div>

            <div>
              <label htmlFor="full-name" className="label">
                Full Name <span className="text-red-500">*</span>
              </label>
              <Input
                id="full-name"
                type="text"
                name="fullName"
                required
                maxLength={200}
                placeholder="Jane Smith"
                autoComplete="name"
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

            <button
              type="submit"
              disabled={pending}
              className="block w-full text-center rounded-xl font-bold text-sm py-3.5 transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ background: '#FCD116', color: '#102246' }}
            >
              {pending ? 'Creating account…' : 'Create Account & Join →'}
            </button>
          </form>

          <p className="text-xs text-center mt-5" style={{ color: '#9CA3AF' }}>
            Already have an account?{' '}
            <Link href={loginUrl}
                  className="font-semibold hover:underline"
                  style={{ color: '#102246' }}>
              Log in
            </Link>
          </p>
        </div>

      </div>
    </div>
  )
}
