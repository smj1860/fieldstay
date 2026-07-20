import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Log In' }

function LoginFormSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden="true">
      <div className="h-11 rounded-xl" style={{ background: 'var(--bg-raised)' }} />
      <div className="h-px my-4" style={{ background: 'var(--border)' }} />
      <div className="h-11 rounded-lg" style={{ background: 'var(--bg-raised)' }} />
      <div className="h-11 rounded-lg" style={{ background: 'var(--bg-raised)' }} />
      <div className="h-11 rounded-lg" style={{ background: 'var(--bg-raised)' }} />
    </div>
  )
}

export default function LoginPage() {
  return (
    <>
      <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Welcome back</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        Sign in to your FieldStay account
      </p>

      <Suspense fallback={<LoginFormSkeleton />}>
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
