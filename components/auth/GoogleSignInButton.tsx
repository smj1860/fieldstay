'use client'

import { createClient } from '@/lib/supabase/client'

interface Props {
  next?:  string
  label?: string
}

export function GoogleSignInButton({
  next,
  label = 'Continue with Google',
}: Readonly<Props>) {
  const supabase = createClient()

  async function handleGoogleSignIn() {
    if (next) {
      document.cookie = `fs-oauth-next=${encodeURIComponent(next)}; path=/; max-age=300; SameSite=Lax; Secure`
    }

    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${globalThis.location.origin}/auth/callback`,
      },
    })
  }

  return (
    <button
      onClick={handleGoogleSignIn}
      type="button"
      className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-card)] text-[var(--text-primary)] text-sm font-semibold hover:bg-[var(--bg-raised)] transition-colors"
    >
      <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
        <path d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.6 20-21 0-1.4-.1-2.7-.5-4z" fill="#FFC107"/>
        <path d="M6.3 14.7l7 5.1C15.1 16.2 19.2 13 24 13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 5.1 29.6 3 24 3c-7.7 0-14.4 4.4-17.7 11.7z" fill="#FF3D00"/>
        <path d="M24 45c5.5 0 10.4-1.9 14.2-5.1l-6.6-5.5C29.5 36.1 26.9 37 24 37c-6 0-10.6-3.9-11.8-9.2l-7 5.4C8.1 40.5 15.5 45 24 45z" fill="#4CAF50"/>
        <path d="M44.5 20H24v8.5h11.8c-.6 2.3-2 4.2-3.8 5.5l6.6 5.5C42 36.2 45 30.7 45 24c0-1.4-.1-2.7-.5-4z" fill="#1976D2"/>
      </svg>
      {label}
    </button>
  )
}
