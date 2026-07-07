'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { AuthChangeEvent } from '@supabase/supabase-js'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

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
    setLoading(false)

    if (error) {
      setError(error.message)
      return
    }

    setSuccess(true)
    setTimeout(() => router.push('/login'), 2000)
  }

  if (success) {
    return (
      <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
        Password updated. Redirecting to sign in…
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg px-4 py-3">
        Verifying your reset link… If this doesn&apos;t resolve, your link
        may have expired. Request a new one from the{' '}
        <a href="/forgot-password" className="underline font-medium">
          forgot password
        </a>{' '}
        page.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
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
          <p className="mt-1.5 text-xs text-red-500">Passwords do not match.</p>
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
