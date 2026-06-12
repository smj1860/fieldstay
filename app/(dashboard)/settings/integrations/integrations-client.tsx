'use client'

import { useState, useTransition } from 'react'
import Link                         from 'next/link'
import { CheckCircle2, XCircle, Loader2, PlugZap, Unplug } from 'lucide-react'
import { cn }                       from '@/lib/utils'
import { disconnectIntegration }    from './actions'
import { formatDate }               from '@/lib/utils'

interface Provider {
  id:          string
  display_name: string
  is_active:   boolean
}

interface Connection {
  id:               string
  provider_id:      string
  status:           string
  external_user_id: string | null
  created_at:       string
  metadata:         Record<string, unknown> | null
}

export function IntegrationsClient({
  providers,
  connectionsByProvider,
}: {
  providers: Provider[]
  connectionsByProvider: Record<string, Connection>
}) {
  if (!providers.length) {
    return (
      <div className="card text-center py-10">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No integrations are available yet.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {providers.map((provider) => {
        const connection = connectionsByProvider[provider.id]
        return (
          <IntegrationCard
            key={provider.id}
            provider={provider}
            connection={connection ?? null}
          />
        )
      })}
    </div>
  )
}

function IntegrationCard({
  provider,
  connection,
}: {
  provider:   Provider
  connection: Connection | null
}) {
  const [disconnecting, startDisconnect] = useTransition()
  const [confirming, setConfirming]      = useState(false)
  const [error, setError]                = useState<string | null>(null)

  const isConnected = connection?.status === 'active'
  const isError     = connection?.status === 'error' || connection?.status === 'revoked'

  const handleDisconnect = () => {
    startDisconnect(async () => {
      const result = await disconnectIntegration(provider.id)
      if (result.error) {
        setError(result.error)
      } else {
        setConfirming(false)
      }
    })
  }

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
              {provider.display_name}
            </h3>
            {isConnected && (
              <span className="badge badge-green text-xs">Connected</span>
            )}
            {isError && (
              <span className="badge badge-red text-xs">Error</span>
            )}
          </div>

          {isConnected && connection && (
            <div className="text-xs space-y-0.5" style={{ color: 'var(--text-muted)' }}>
              {connection.external_user_id && (
                <p>Account ID: {connection.external_user_id}</p>
              )}
              <p>Connected {formatDate(connection.created_at)}</p>
            </div>
          )}

          {isError && (
            <p className="text-xs mt-1" style={{ color: 'var(--accent-red)' }}>
              Token revoked or expired. Reconnect to restore sync.
            </p>
          )}

          {error && (
            <p className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex-shrink-0">
          {!connection || isError ? (
            <Link
              href={`/api/integrations/${provider.id}/connect`}
              className="btn-secondary text-sm flex items-center gap-1.5"
            >
              <PlugZap className="w-3.5 h-3.5" />
              {isError ? 'Reconnect' : 'Connect'}
            </Link>
          ) : confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Disconnect?</span>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="btn-danger text-xs py-1.5 px-2.5"
              >
                {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="btn-ghost text-xs py-1.5"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="btn-ghost text-sm flex items-center gap-1.5"
              style={{ color: 'var(--text-muted)' }}
            >
              <Unplug className="w-3.5 h-3.5" />
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
