'use client'

import Link from 'next/link'

interface Props {
  token:   string
  email:   string
  orgName: string
}

export function AcceptForm({ token, email, orgName }: Props) {
  const signupUrl = `/signup?invite_token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`
  const loginUrl  = `/login?invite_token=${encodeURIComponent(token)}`

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
              <span className="text-xl">✉️</span>
            </div>
            <h1 className="text-xl font-black tracking-tight mb-1"
                style={{ color: '#111827', letterSpacing: '-0.5px' }}>
              You've been invited
            </h1>
            <p className="text-sm" style={{ color: '#6B7280' }}>
              Join <strong style={{ color: '#111827' }}>{orgName}</strong> on FieldStay
            </p>
          </div>

          <div className="space-y-3">
            <a href={signupUrl}
               className="block w-full text-center rounded-xl font-bold text-sm py-3.5 transition-opacity hover:opacity-90"
               style={{ background: '#FCD116', color: '#102246' }}>
              Create your FieldStay account
            </a>

            <a href={loginUrl}
               className="block w-full text-center rounded-xl font-bold text-sm py-3.5 transition-colors"
               style={{ background: 'transparent', color: '#102246', border: '1.5px solid #E5E7EB' }}>
              Log in to an existing account
            </a>
          </div>

          <p className="text-xs text-center mt-5" style={{ color: '#9CA3AF' }}>
            You&apos;ll be added to <strong>{orgName}</strong> automatically after signing in.
          </p>
        </div>

      </div>
    </div>
  )
}
