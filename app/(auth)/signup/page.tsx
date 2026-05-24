import type { Metadata } from 'next'
import Link from 'next/link'
import { SignupForm } from './signup-form'

export const metadata: Metadata = { title: 'Sign Up — FieldStay' }

export default function SignupPage() {
  return (
    <>
      <h2 className="text-xl font-bold text-accent-900 mb-1">Create your account</h2>
      <p className="text-sm text-accent-500 mb-6">Start your 14-day free trial. No credit card required.</p>
      <SignupForm />
      <p className="text-center text-sm text-accent-500 mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-700 font-medium hover:underline">Sign in</Link>
      </p>
    </>
  )
}
