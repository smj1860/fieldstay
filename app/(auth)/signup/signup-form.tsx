'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton'
import Link from 'next/link'

export function SignupForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const inviteToken  = searchParams.get('invite_token')
  const next         = searchParams.get('next') ?? undefined
  const prefillEmail = searchParams.get('email') ?? ''

  const [fullName,         setFullName]         = useState('')
  const [email,            setEmail]             = useState(prefillEmail)
  const [password,         setPassword]          = useState('')
  const [confirmPassword,  setConfirmPassword]   = useState('')
  const [passwordMismatch, setPasswordMismatch]  = useState(false)
  const [error,            setError]             = useState<string | null>(null)
  const [loading,          setLoading]           = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setPasswordMismatch(true)
      return
    }
    setPasswordMismatch(false)
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
    <div className="space-y-4">
      <GoogleSignInButton next={next} label="Sign up with Google" />

      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-[var(--border)]" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="px-3 bg-[var(--bg-card)] text-[var(--text-muted)]">
            or continue with email
          </span>
        </div>
      </div>

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
          onChange={(e) => { setPassword(e.target.value); setPasswordMismatch(false) }}
          className="input"
          placeholder="••••••••"
        />
        <p className="text-xs text-accent-400 mt-1">Minimum 8 characters</p>
      </div>

      <div>
        <label htmlFor="confirmPassword" className="label">Confirm Password</label>
        <input
          id="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMismatch(false) }}
          className="input"
          placeholder="Re-enter your password"
        />
        {passwordMismatch && (
          <p className="mt-1.5 text-xs text-red-500">Passwords do not match.</p>
        )}
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-2.5"
      >
        {loading ? 'Creating account…' : 'Create Account'}
      </button>

      <p className="text-xs text-center leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        By creating an account you agree to our{' '}
        <Link href="/terms" className="underline underline-offset-2 hover:opacity-80">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="underline underline-offset-2 hover:opacity-80">
          Privacy Policy
        </Link>
        .
      </p>
      </form>
    </div>
  )
}
