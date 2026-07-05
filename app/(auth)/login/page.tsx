import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Log In' }

export default function LoginPage() {
  return (
    <>
      <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Welcome back</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        Sign in to your FieldStay account
      </p>

      <Suspense>
        <LoginForm />
      </Suspense>

      <p className="text-center text-sm mt-6" style={{ color: 'var(--text-muted)' }}>
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-brand-700 font-medium hover:underline">
          Start free trial
        </Link>
      </p>

      <p className="text-center text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
        <Link href="/forgot-password" className="text-brand-700 hover:underline">
          Forgot password?
        </Link>
      </p>
    </>
  )
}
