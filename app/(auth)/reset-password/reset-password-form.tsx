'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { AuthChangeEvent } from '@supabase/supabase-js'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'

export function ResetPasswordForm() {
  const router = useRouter()
  const [ready,           setReady]           = useState(false)
  const [error,           setError]           = useState<string | null>(null)
  const [success,         setSuccess]         = useState(false)
  const [loading,         setLoading]         = useState(false)
  const [password,        setPassword]        = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [mismatch,        setMismatch]        = useState(false)

  // The recovery code was already exchanged server-side by /auth/callback
  // before the user landed here, so there is an active session in the cookie.
  // Listen for PASSWORD_RECOVERY (implicit flow) and fall back to getSession()
  // for the PKCE path where the session is already present on mount.
  useEffect(() => {
    const supabase = createClient()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent) => {
        if (event === 'PASSWORD_RECOVERY') {
          setReady(true)
        }
      }
    )

    async function checkSession() {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) setReady(true)
    }
    checkSession()

    return () => subscription.unsubscribe()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMismatch(false)

    if (password !== confirmPassword) {
      setMismatch(true)
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      setLoading(false)
      setError(error.message)
      return
    }

    // Revoke every session, on every device, before sending them to sign in
    // again. updateUser() changes the password and leaves all existing
    // sessions alive — so the most common reason to reset one ("someone else
    // got into my account") did not actually evict that someone. They kept a
    // working session; only the password they no longer needed had changed.
    //
    // Errors here are surfaced rather than swallowed: the password IS already
    // updated at this point, so the user must not be told the reset failed —
    // but they do need to know the old sessions may still be live, because
    // that is the difference between "handled" and "still compromised".
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' })
    setLoading(false)

    if (signOutError) {
      console.error('[reset-password] global sign-out failed:', signOutError.message)
      setError(
        'Your password was updated, but we could not sign out your other devices. ' +
        'Sign in and use Settings to sign out everywhere.'
      )
      return
    }

    setSuccess(true)
    setTimeout(() => router.push('/login'), 2000)
  }

  if (success) {
    return (
      <InlineAlert tone="success">
        Password updated. Redirecting to sign in…
      </InlineAlert>
    )
  }

  if (!ready) {
    return (
      <InlineAlert tone="warning">
        Verifying your reset link… If this doesn&apos;t resolve, your link
        may have expired. Request a new one from the{' '}
        <a href="/forgot-password" className="underline font-medium">
          forgot password
        </a>{' '}
        page.
      </InlineAlert>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <InlineAlert tone="error">{error}</InlineAlert>
      )}

      <div>
        <label htmlFor="new-password" className="label">New Password</label>
        <Input
          id="new-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setMismatch(false) }}
          placeholder="Min. 8 characters"
        />
      </div>

      <div>
        <label htmlFor="confirm-password" className="label">Confirm New Password</label>
        <Input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setMismatch(false) }}
          placeholder="Re-enter your new password"
        />
        {mismatch && (
          <p className="mt-1.5 text-xs" style={{ color: 'var(--accent-red)' }}>Passwords do not match.</p>
        )}
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full py-2.5"
      >
        {loading ? 'Updating…' : 'Update Password'}
      </Button>
    </form>
  )
}
