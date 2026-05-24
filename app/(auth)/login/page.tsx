import type { Metadata } from 'next'
import Link from 'next/link'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Log In' }

export default function LoginPage() {
  return (
    <>
      <h2 className="text-xl font-bold text-accent-900 mb-1">Welcome back</h2>
      <p className="text-sm text-accent-500 mb-6">
        Sign in to your FieldStay account
      </p>

      <LoginForm />

      <p className="text-center text-sm text-accent-500 mt-6">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-brand-700 font-medium hover:underline">
          Start free trial
        </Link>
      </p>

      <p className="text-center text-sm text-accent-500 mt-2">
        <Link href="/forgot-password" className="text-brand-700 hover:underline">
          Forgot password?
        </Link>
      </p>
    </>
  )
}
