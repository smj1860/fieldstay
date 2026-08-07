'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'

export function ForgotPasswordForm() {
  const [email,     setEmail]     = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading,   setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const supabase = createClient()
    // Route through the PKCE callback handler so the recovery code is
    // exchanged server-side before forwarding to /reset-password.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${globalThis.location?.origin}/auth/callback?next=/reset-password`,
    })

    setLoading(false)

    // Always show the success state regardless of whether the email exists
    // — prevents user enumeration via this endpoint.
    if (error) {
      console.error('resetPasswordForEmail error:', error.message)
    }
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <InlineAlert tone="success">
        If an account exists for <strong>{email}</strong>, a password reset
        link has been sent. Check your inbox.
      </InlineAlert>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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

      <Button
        type="submit"
        disabled={loading}
        className="w-full py-2.5"
      >
        {loading ? 'Sending…' : 'Send Reset Link'}
      </Button>
    </form>
  )
}
