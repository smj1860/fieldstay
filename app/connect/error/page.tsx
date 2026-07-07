import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Connection Error — FieldStay' }

const REASON_MESSAGES: Record<string, string> = {
  access_denied:          'You declined the authorization request.',
  missing_params:         'The connection request was missing required information. Please try again.',
  invalid_state:          'This connection link has expired or was already used. Please try connecting again.',
  unknown_provider:       'That integration isn’t recognized.',
  provider_not_oauth:     'That integration doesn’t use this connection method.',
  token_exchange_failed:  'We couldn’t complete the connection with the provider. Please try again.',
  storage_failed:         'We connected successfully but couldn’t save the connection securely. Please try again.',
  claim_failed:           'We couldn’t finish linking your connection to your new account. Please reconnect from Settings.',
}

export default async function ConnectErrorPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ provider?: string; error?: string }> }>) {
  const { provider, error } = await searchParams
  const message = (error && REASON_MESSAGES[error])
    ?? 'Something went wrong while connecting your account.'

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-8 text-center"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          {provider ? `Couldn’t connect ${provider}` : 'Connection failed'}
        </h1>
        <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
          {message}
        </p>
        <Link
          href="/settings?tab=integrations"
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold"
          style={{ background: 'var(--accent-gold)', color: 'var(--bg-primary)' }}
        >
          Back to Integrations
        </Link>
      </div>
    </div>
  )
}
