'use client'

import { useState, useTransition, useEffect } from 'react'
import Link                                    from 'next/link'
import { Loader2, PlugZap, Unplug }            from 'lucide-react'
import { disconnectIntegration, getSyncProgress } from './actions'
import { formatDate }                          from '@/lib/utils'

interface Provider {
  id:           string
  display_name: string
  is_active:    boolean
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
  providers:             Provider[]
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

type SyncProgress = {
  propertiesFound: number | null
  bookingsFound:   number | null
  lastSyncStatus:  string | null
}

function getSyncCopy(propertiesFound: number | null, bookingsFound: number | null): string {
  if (bookingsFound !== null) {
    return `Found ${bookingsFound} booking${bookingsFound !== 1 ? 's' : ''} — finishing up…`
  }
  if (propertiesFound !== null) {
    const noun = propertiesFound !== 1 ? 'properties' : 'property'
    return `Found ${propertiesFound} ${noun} — pulling in your booking history…`
  }
  return 'Connecting to OwnerRez…'
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

  // --- Sync progress polling ---
  const initialMeta        = (connection?.metadata ?? {}) as Record<string, unknown>
  const initialSyncStatus  = typeof initialMeta.last_sync_status === 'string'
    ? initialMeta.last_sync_status
    : null
  const initiallyTerminal  = initialSyncStatus === 'success' || initialSyncStatus === 'error'

  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [syncTimedOut, setSyncTimedOut] = useState(false)

  const effectiveSyncStatus   = syncProgress?.lastSyncStatus ?? initialSyncStatus
  const effectivePropsFound   = syncProgress?.propertiesFound
    ?? (typeof initialMeta.properties_found === 'number' ? initialMeta.properties_found : null)
  const effectiveBookingsFound = syncProgress?.bookingsFound
    ?? (typeof initialMeta.bookings_found === 'number' ? initialMeta.bookings_found : null)

  const isTerminal = effectiveSyncStatus === 'success' || effectiveSyncStatus === 'error'

  // Poll while the connection is active but the sync has no terminal result yet.
  // Starts immediately after OAuth redirect (metadata has no last_sync_status yet)
  // and also picks up if the user navigates to the page mid-sync.
  const shouldPoll = connection?.status === 'active' && !initiallyTerminal && !isTerminal && !syncTimedOut

  useEffect(() => {
    if (!shouldPoll) return

    const POLL_INTERVAL_MS = 2500
    const TIMEOUT_MS       = 3 * 60 * 1000 // 3 minutes — well past the 30-90s worst case
    const startedAt        = Date.now()

    const poll = async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setSyncTimedOut(true)
        clearInterval(intervalId)
        return
      }
      try {
        const progress = await getSyncProgress(provider.id)
        if (progress) {
          setSyncProgress(progress)
          if (progress.lastSyncStatus === 'success' || progress.lastSyncStatus === 'error') {
            clearInterval(intervalId)
          }
        }
      } catch {
        // Ignore transient poll errors — keep polling
      }
    }

    poll()
    const intervalId = setInterval(poll, POLL_INTERVAL_MS)

    return () => clearInterval(intervalId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.status, initiallyTerminal, provider.id])

  // Derived display state
  const isConnected     = connection?.status === 'active' && effectiveSyncStatus === 'success'
  const isError         = connection?.status === 'error'
                       || connection?.status === 'revoked'
                       || effectiveSyncStatus === 'error'
  const isSyncInProgress = connection?.status === 'active' && !isConnected && !isError

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

        <div className="flex-shrink-0">
          {isSyncInProgress ? (
            <div className="flex items-center gap-2 py-1">
              {!syncTimedOut && (
                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
              )}
              <span className="text-xs max-w-[220px] text-right" style={{ color: 'var(--text-muted)' }}>
                {syncTimedOut
                  ? 'Taking longer than expected — try refreshing or contact support.'
                  : getSyncCopy(effectivePropsFound, effectiveBookingsFound)}
              </span>
            </div>
          ) : !connection || isError ? (
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
