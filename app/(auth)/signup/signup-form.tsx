'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function SignupForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const inviteToken  = searchParams.get('invite_token')
  const prefillEmail = searchParams.get('email') ?? ''

  const [fullName, setFullName] = useState('')
  const [email,    setEmail]    = useState(prefillEmail)
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()

    // Build the emailRedirectTo URL — include invite_token so the callback
    // can process the invite acceptance after email confirmation.
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin
    const nextParam = inviteToken
      ? `/auth/callback?invite_token=${encodeURIComponent(inviteToken)}`
      : '/auth/callback'

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data:            { full_name: fullName },
        emailRedirectTo: `${appUrl}${nextParam}`,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // If invite flow: show confirmation message (user needs to verify email)
    router.push(inviteToken ? '/signup?check_email=1' : '/onboarding')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {inviteToken && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded-lg px-4 py-3">
          You&apos;re creating an account to accept a team invitation.
        </div>
      )}

      <div>
        <label htmlFor="fullName" className="label">Full Name</label>
        <input
          id="fullName"
          type="text"
          required
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="input"
          placeholder="Jane Smith"
        />
      </div>

      <div>
        <label htmlFor="email" className="label">Email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="label">Password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder="••••••••"
        />
        <p className="text-xs text-accent-400 mt-1">Minimum 8 characters</p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-2.5"
      >
        {loading ? 'Creating account…' : 'Create Account'}
      </button>
    </form>
  )
}
