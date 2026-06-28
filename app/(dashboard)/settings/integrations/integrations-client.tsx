'use client'

import { useState, useTransition, useEffect } from 'react'
import Link                                    from 'next/link'
import { useSearchParams, useRouter }          from 'next/navigation'
import { Loader2, PlugZap, Unplug, X }         from 'lucide-react'
import { disconnectIntegration, getSyncProgress, connectWithApiKey } from './actions'
import { formatDate }                          from '@/lib/utils'

// ── Provider credential definitions ──────────────────────────────────────────
// Each api_key provider declares what fields the PM needs to fill in.

const API_KEY_PROVIDER_FIELDS: Record<string, {
  description: string
  fields: Array<{ key: string; label: string; placeholder: string; sensitive?: boolean }>
}> = {
  hostaway: {
    description: 'Syncs your Hostaway listings and reservations automatically.',
    fields: [
      {
        key:         'accountId',
        label:       'Account ID',
        placeholder: 'Find in Settings → Hostaway API',
      },
      {
        key:         'apiKey',
        label:       'API Key',
        placeholder: 'Your Hostaway secret API key',
        sensitive:   true,
      },
    ],
  },
  // Guesty is not yet wired — hidden until the integration is live.
  // guesty: {
  //   description: 'Syncs your Guesty listings and reservations automatically.',
  //   fields: [
  //     {
  //       key:         'clientId',
  //       label:       'Client ID',
  //       placeholder: 'From Guesty → Integrations → API & Webhooks',
  //     },
  //     {
  //       key:         'clientSecret',
  //       label:       'Client Secret',
  //       placeholder: 'Your Guesty client secret',
  //       sensitive:   true,
  //     },
  //   ],
  // },
}

// ── Provider display config (descriptions shown on each card) ─────────────────
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  ownerrez: 'Syncs bookings, properties, and guest reviews. Enables automatic revenue posting to owner ledgers.',
  hostaway: 'Connects your Hostaway account to sync all listings and reservations in real time.',
  // Guesty is not yet wired — hidden until the integration is live.
  // guesty:   'Connects your Guesty account to sync all listings and reservations in real time.',
  kroger:   'Builds Kroger grocery carts automatically from below-par inventory items.',
}

// Providers not yet wired — excluded from the rendered list until live.
const HIDDEN_PROVIDER_IDS = new Set<string>(['guesty'])

interface Provider {
  id:           string
  display_name: string
  auth_type:    string
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
  const searchParams = useSearchParams()
  const router       = useRouter()
  const [connectingProvider, setConnectingProvider] = useState<string | null>(
    searchParams.get('connect')
  )

  // Clear the param from URL once the modal opens, so refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('connect')) {
      router.replace('/settings/integrations', { scroll: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!providers.length) {
    return (
      <div className="card text-center py-10">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No integrations are available yet.
        </p>
      </div>
    )
  }

  const connectingProviderInfo = connectingProvider
    ? providers.find((p) => p.id === connectingProvider)
    : null

  return (
    <div className="space-y-4">
      {providers.filter((provider) => !HIDDEN_PROVIDER_IDS.has(provider.id)).map((provider) => {
        const connection = connectionsByProvider[provider.id]
        return (
          <IntegrationCard
            key={provider.id}
            provider={provider}
            connection={connection ?? null}
            onConnectClick={() => setConnectingProvider(provider.id)}
          />
        )
      })}

      {connectingProviderInfo && API_KEY_PROVIDER_FIELDS[connectingProviderInfo.id] && (
        <CredentialModal
          providerId={connectingProviderInfo.id}
          displayName={connectingProviderInfo.display_name}
          onClose={() => setConnectingProvider(null)}
          onSuccess={() => {
            setConnectingProvider(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function CredentialModal({
  providerId,
  displayName,
  onClose,
  onSuccess,
}: {
  providerId:  string
  displayName: string
  onClose:     () => void
  onSuccess:   (externalUserId: string) => void
}) {
  const config = API_KEY_PROVIDER_FIELDS[providerId]
  if (!config) return null

  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(config.fields.map((f) => [f.key, '']))
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, startConnect] = useTransition()

  const handleConnect = () => {
    setError(null)
    startConnect(async () => {
      const result = await connectWithApiKey(providerId, values)
      if (result.error) {
        setError(result.error)
      } else if (result.externalUserId) {
        onSuccess(result.externalUserId)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div
        className="relative w-full max-w-md rounded-2xl p-6"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-xl)' }}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 p-1 rounded-lg"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Connect {displayName}
        </h2>
        <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
          {config.description}
        </p>

        {error && (
          <div
            className="text-sm rounded-lg px-3 py-2.5 mb-4"
            style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
          >
            {error}
          </div>
        )}

        <div className="space-y-4 mb-6">
          {config.fields.map((field) => (
            <div key={field.key}>
              <label
                className="block text-sm font-medium mb-1.5"
                style={{ color: 'var(--text-secondary)' }}
              >
                {field.label}
              </label>
              <input
                type={field.sensitive ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className="input w-full"
                autoComplete="off"
              />
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleConnect}
            disabled={pending}
            className="btn-primary flex-1 flex items-center justify-center gap-2"
          >
            {pending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</>
            ) : (
              <><PlugZap className="w-4 h-4" /> Connect</>
            )}
          </button>
          <button onClick={onClose} className="btn-secondary px-4">
            Cancel
          </button>
        </div>

        {/* Where to find credentials — provider-specific help text */}
        {providerId === 'hostaway' && (
          <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
            Find these in your Hostaway dashboard under{' '}
            <strong>Settings → Hostaway API → Create</strong>. The key is only shown once — save it securely.
          </p>
        )}
        {/* Guesty is not yet wired — hidden until the integration is live.
        {providerId === 'guesty' && (
          <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
            Create these in your Guesty dashboard under{' '}
            <strong>Integrations → API &amp; Webhooks → New Application</strong>.
          </p>
        )} */}
      </div>
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
  return 'Connecting…'
}

function IntegrationCard({
  provider,
  connection,
  onConnectClick,
}: {
  provider:       Provider
  connection:     Connection | null
  onConnectClick: () => void
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

          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {PROVIDER_DESCRIPTIONS[provider.id] ?? ''}
          </p>

          {isConnected && connection && (
            <div className="text-xs space-y-0.5 mt-1.5" style={{ color: 'var(--text-muted)' }}>
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
            provider.auth_type === 'api_key' ? (
              <button
                onClick={onConnectClick}
                className="btn-secondary text-sm flex items-center gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {isError ? 'Reconnect' : 'Connect'}
              </button>
            ) : (
              <Link
                href={`/api/integrations/${provider.id}/connect`}
                className="btn-secondary text-sm flex items-center gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {isError ? 'Reconnect' : 'Connect'}
              </Link>
            )
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
