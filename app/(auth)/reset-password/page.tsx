import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ResetPasswordForm } from './reset-password-form'

export const metadata: Metadata = { title: 'Reset Password' }

export default function ResetPasswordPage() {
  return (
    <>
      <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        Set a new password
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        Choose a new password for your account
      </p>

      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </>
  )
}
