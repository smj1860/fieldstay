'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton'
import { acceptInviteForCurrentUser } from './actions'
import Link from 'next/link'

const ERROR_MESSAGES: Record<string, string> = {
  auth_callback:              'Sign-in failed. Please try again.',
  auth_callback_missing_code: 'The sign-in link is incomplete. Please request a new one.',
  link_expired:               'This sign-in link has expired. Please request a new one.',
  already_used:               'This sign-in link has already been used. Please sign in directly.',
}

export function LoginForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const next         = searchParams.get('next') ?? '/ops'
  const inviteToken  = searchParams.get('invite_token')

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)

  const errorCode    = searchParams.get('error')
  const callbackError = errorCode ? (ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Please try again.') : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    if (inviteToken) {
      await acceptInviteForCurrentUser(inviteToken)
      router.push('/ops')
      router.refresh()
      return
    }

    router.push(next)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {callbackError && (
        <div
          className="px-4 py-3 rounded-lg text-sm"
          style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}
        >
          {callbackError}
        </div>
      )}

      <GoogleSignInButton next={next} label="Sign in with Google" />

      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-[var(--border)]" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="px-3 bg-[var(--bg-card)] text-[var(--text-muted)]">
            or sign in with email
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder="••••••••"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-2.5"
      >
        {loading ? 'Signing in…' : 'Sign In'}
      </button>
      </form>

      <div className="flex items-center justify-center gap-4 pt-2">
        <Link
          href="/privacy"
          className="text-xs hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          Privacy
        </Link>
        <span style={{ color: 'var(--border)' }}>·</span>
        <Link
          href="/terms"
          className="text-xs hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          Terms
        </Link>
        <span style={{ color: 'var(--border)' }}>·</span>
        <Link
          href="/dpa"
          className="text-xs hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          DPA
        </Link>
      </div>
    </div>
  )
}
