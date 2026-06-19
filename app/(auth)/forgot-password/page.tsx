import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata: Metadata = { title: 'Forgot Password' }

export default function ForgotPasswordPage() {
  return (
    <>
      <h2 className="text-xl font-bold mb-1" style={{ color: '#0a1628' }}>
        Reset your password
      </h2>
      <p className="text-sm mb-6" style={{ color: '#64748b' }}>
        Enter your email and we&apos;ll send you a reset link
      </p>

      <Suspense>
        <ForgotPasswordForm />
      </Suspense>

      <p className="text-center text-sm mt-6" style={{ color: '#64748b' }}>
        <Link href="/login" className="text-brand-700 font-medium hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  )
}
