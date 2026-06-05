import type { Metadata } from 'next'
import Link              from 'next/link'
import { Suspense }      from 'react'
import { SignupForm }    from './signup-form'

export const metadata: Metadata = { title: 'Sign Up — FieldStay' }

export default function SignupPage() {
  return (
    <>
      <h2 className="text-xl font-bold mb-1" style={{ color: '#0a1628' }}>Create your account</h2>
      <p className="text-sm mb-6" style={{ color: '#64748b' }}>Start your 14-day free trial. No credit card required.</p>
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
      <p className="text-center text-sm mt-6" style={{ color: '#64748b' }}>
        Already have an account?{' '}
        <Link href="/login" className="text-brand-700 font-medium hover:underline">Sign in</Link>
      </p>
    </>
  )
}
