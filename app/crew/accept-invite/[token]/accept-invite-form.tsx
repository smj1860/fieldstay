'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function AcceptInviteForm({
  token,
  crewId,
  email,
  name,
}: {
  token:  string
  crewId: string
  email:  string
  name:   string
}) {
  const router              = useRouter()
  const [password, setPass] = useState('')
  const [confirm, setConf]  = useState('')
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoad]  = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoad(true)
    try {
      const supabase = createClient()

      const { data, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      })

      if (signUpErr)  throw signUpErr
      if (!data.user) throw new Error('Account creation failed — please try again')

      const res = await fetch('/api/crew/accept-invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, userId: data.user.id }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to activate account')
      }

      router.push('/crew')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoad(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div>
        <label className="label">Email</label>
        <input
          type="email"
          value={email}
          disabled
          className="input bg-accent-50 text-accent-500 cursor-not-allowed"
        />
      </div>

      <div>
        <label className="label">
          Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPass(e.target.value)}
          className="input"
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
      </div>

      <div>
        <label className="label">
          Confirm Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConf(e.target.value)}
          className="input"
          placeholder="Repeat password"
          autoComplete="new-password"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-cta w-full py-2.5 disabled:opacity-60"
      >
        {loading ? 'Creating account…' : 'Activate Account →'}
      </button>
    </form>
  )
}
