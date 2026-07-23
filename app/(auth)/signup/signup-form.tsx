'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
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
  const [emailExists,      setEmailExists]       = useState(false)
  const [loading,          setLoading]           = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setEmailExists(false)

    if (password !== confirmPassword) {
      setPasswordMismatch(true)
      return
    }
    setPasswordMismatch(false)
    setLoading(true)

    const supabase = createClient()

    // Build the emailRedirectTo URL — include invite_token and/or next as
    // query params so the callback can process them after email confirmation.
    // A cookie (like GoogleSignInButton uses for the OAuth path) doesn't work
    // here: confirmation can happen minutes/hours later, on a different
    // device/browser than the one that started signup. Query params on
    // emailRedirectTo survive that round-trip; Supabase appends its own
    // code param onto whatever URL we give it here.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? globalThis.location?.origin
    const callbackParams = new URLSearchParams()
    if (inviteToken) callbackParams.set('invite_token', inviteToken)
    if (next)        callbackParams.set('next', next)
    const query     = callbackParams.toString()
    const nextParam = `/auth/callback${query ? `?${query}` : ''}`

    const { error, data } = await supabase.auth.signUp({
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

    // Supabase never returns an error for signUp() against an email that's
    // already registered and confirmed — it responds as if signup succeeded,
    // with a fake user object whose identities array is empty, specifically
    // so signup can't be used to probe which emails already have accounts.
    // No account is created and no confirmation email is sent. Detect that
    // here so the user sees why, instead of being pushed onward as if a new
    // account had just been created.
    if (data.user && data.user.identities?.length === 0) {
      setEmailExists(true)
      setLoading(false)
      return
    }

    // If invite flow: show confirmation message (user needs to verify email).
    // Otherwise: if this project has email confirmation disabled, signUp()
    // already returns an active session — honor `next` immediately rather
    // than waiting on a confirmation email that will never be sent. If
    // confirmation IS required, this push lands on a page that requires auth
    // and bounces to /login harmlessly; the real destination is reached via
    // the emailRedirectTo link above once they confirm.
    router.push(inviteToken ? '/signup?check_email=1' : (data.session ? (next ?? '/onboarding') : '/onboarding'))
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

      {emailExists && (
        <div
          className="text-sm rounded-lg px-4 py-3"
          style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid var(--accent-amber)' }}
        >
          An account with this email already exists.{' '}
          <Link href="/login" className="underline font-medium">Log in</Link>
          {' '}instead, or use{' '}
          <Link href="/forgot-password" className="underline font-medium">forgot password</Link>
          {' '}if you don&apos;t remember it.
        </div>
      )}

      {inviteToken && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded-lg px-4 py-3">
          You&apos;re creating an account to accept a team invitation.
        </div>
      )}

      <div>
        <label htmlFor="fullName" className="label">Full Name</label>
        <Input
          id="fullName"
          type="text"
          required
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Jane Smith"
        />
      </div>

      <div>
        <label htmlFor="email" className="label">Email</label>
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="label">Password</label>
        <Input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setPasswordMismatch(false) }}
          placeholder="••••••••"
        />
        <p className="text-xs text-accent-400 mt-1">Minimum 8 characters</p>
      </div>

      <div>
        <label htmlFor="confirmPassword" className="label">Confirm Password</label>
        <Input
          id="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMismatch(false) }}
          placeholder="Re-enter your password"
        />
        {passwordMismatch && (
          <p className="mt-1.5 text-xs text-red-500">Passwords do not match.</p>
        )}
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full py-2.5"
      >
        {loading ? 'Creating account…' : 'Create Account'}
      </Button>

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
