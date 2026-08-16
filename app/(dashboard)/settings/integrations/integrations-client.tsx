'use client'

import { asJsonObject } from '@/lib/json'
import type { Json } from '@/types/database'
import { useState, useTransition, useEffect } from 'react'
import { useSearchParams, useRouter }          from 'next/navigation'
import { Loader2, PlugZap, Unplug, RefreshCw }  from 'lucide-react'
import { disconnectIntegration, getSyncProgress, connectWithApiKey, triggerResync } from './actions'
import { formatDate }                          from '@/lib/utils'
import { Dialog }                              from '@/components/ui/Dialog'
import { Card }                                from '@/components/ui/Card'
import { Badge }                               from '@/components/ui/Badge'
import { Button, buttonVariantClass }           from '@/components/ui/Button'
import { Input }                               from '@/components/ui/Input'
import { reportError }                         from '@/lib/observability/report-error'

// ── Provider credential definitions ──────────────────────────────────────────
// Each api_key provider declares what fields the PM needs to fill in.

const API_KEY_PROVIDER_FIELDS: Record<string, {
  description: string
  fields: Array<{ key: string; label: string; placeholder: string; sensitive?: boolean }>
}> = {
  // Hostaway is not fully implemented yet — its sync never fires
  // booking/confirmed (see ops/page.tsx's REVENUE_AUTOMATION_PROVIDER_IDS
  // comment), so a connected org would get properties/bookings synced in
  // with no automatic revenue posting. Hidden until that lands.
  // hostaway: {
  //   description: 'Syncs your Hostaway listings and reservations automatically.',
  //   fields: [
  //     {
  //       key:         'accountId',
  //       label:       'Account ID',
  //       placeholder: 'Find in Settings → Hostaway API',
  //     },
  //     {
  //       key:         'apiKey',
  //       label:       'API Key',
  //       placeholder: 'Your Hostaway secret API key',
  //       sensitive:   true,
  //     },
  //   ],
  // },
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
  ownerrez:   'Syncs bookings, properties, and guest reviews. Enables automatic revenue posting to owner ledgers.',
  hospitable: 'Syncs properties, reservations, and crew from your Hospitable account.',
  // Hostaway is not fully implemented yet — hidden until it posts revenue
  // automatically like the other PMS integrations. See HIDDEN_PROVIDER_IDS.
  // hostaway: 'Connects your Hostaway account to sync all listings and reservations in real time.',
  // Guesty is not yet wired — hidden until the integration is live.
  // guesty:   'Connects your Guesty account to sync all listings and reservations in real time.',
  hostex:     'Syncs properties and reservations from your Hostex account. Posts booking revenue to owner ledgers automatically.',
  kroger:     "Builds Kroger grocery carts automatically from below-par inventory items. Works with any nearby Kroger-owned store — Kroger, Ralphs, Fred Meyer, King Soopers, Smith's, Fry's, QFC, City Market, Dillons, Baker's, Gerbes, Harris Teeter, Mariano's, Pick 'n Save, Metro Market, Food 4 Less, and Foods Co.",
}

// Providers not yet wired (or not fully implemented) — excluded from the
// rendered list until live. Hostaway's sync never fires booking/confirmed
// (see ops/page.tsx's REVENUE_AUTOMATION_PROVIDER_IDS comment) — hidden so
// nobody connects it expecting automatic revenue posting.
const HIDDEN_PROVIDER_IDS = new Set<string>(['guesty', 'hostaway'])

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
  // jsonb — narrowed with asJsonObject() before use, never indexed raw.
  metadata:         Json
}

export function IntegrationsClient({
  providers,
  connectionsByProvider,
  canDisconnect,
}: {
  providers:             Provider[]
  connectionsByProvider: Record<string, Connection>
  canDisconnect:         boolean
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
      <Card className="text-center py-10">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No integrations are available yet.
        </p>
      </Card>
    )
  }

  const connectingProviderInfo = connectingProvider
    ? providers.find((p) => p.id === connectingProvider)
    : null

  return (
    <div className="space-y-4">
      {providers.filter((provider) => (
        // Hidden providers stay hidden UNLESS this org holds a connection to
        // one — an existing connection must always be visible and removable,
        // whatever the provider's rollout state. Same reasoning as the
        // is_active widening in page.tsx.
        !HIDDEN_PROVIDER_IDS.has(provider.id) || connectionsByProvider[provider.id]
      )).map((provider) => {
        const connection = connectionsByProvider[provider.id]
        return (
          <IntegrationCard
            key={provider.id}
            provider={provider}
            connection={connection ?? null}
            onConnectClick={() => setConnectingProvider(provider.id)}
            canDisconnect={canDisconnect}
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
  return (
    <CredentialModalContent
      providerId={providerId}
      displayName={displayName}
      config={config}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  )
}

type ProviderConfig = { description: string; fields: Array<{ key: string; label: string; placeholder: string; sensitive?: boolean }> }

function CredentialModalContent({
  providerId,
  displayName,
  config,
  onClose,
  onSuccess,
}: {
  providerId:  string
  displayName: string
  config:      ProviderConfig
  onClose:     () => void
  onSuccess:   (externalUserId: string) => void
}) {
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
    <Dialog
      open
      onClose={onClose}
      title={`Connect ${displayName}`}
      maxWidthClassName="max-w-md"
      footer={
        <>
          <Button
            onClick={handleConnect}
            disabled={pending}
            className="flex-1 flex items-center justify-center gap-2"
          >
            {pending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</>
            ) : (
              <><PlugZap className="w-4 h-4" /> Connect</>
            )}
          </Button>
          <Button variant="secondary" onClick={onClose} className="px-4">
            Cancel
          </Button>
        </>
      }
    >
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
              htmlFor={field.key}
              className="block text-sm font-medium mb-1.5"
              style={{ color: 'var(--text-secondary)' }}
            >
              {field.label}
            </label>
            <Input
              id={field.key}
              type={field.sensitive ? 'password' : 'text'}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full"
              autoComplete="off"
            />
          </div>
        ))}
      </div>

      {/* Where to find credentials — provider-specific help text */}
      {/* Hostaway is not fully implemented yet — hidden until it posts
      revenue automatically like the other PMS integrations.
      {providerId === 'hostaway' && (
        <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
          Find these in your Hostaway dashboard under{' '}
          <strong>Settings → Hostaway API → Create</strong>. The key is only shown once — save it securely.
        </p>
      )} */}
      {/* Guesty is not yet wired — hidden until the integration is live.
      {providerId === 'guesty' && (
        <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
          Create these in your Guesty dashboard under{' '}
          <strong>Integrations → API &amp; Webhooks → New Application</strong>.
        </p>
      )} */}
    </Dialog>
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

// ── Sync progress polling ────────────────────────────────────────────────────

interface SyncState {
  status:         string | null
  propertiesFound: number | null
  bookingsFound:   number | null
  isTerminal:      boolean
  timedOut:        boolean
  pollError:       string | null
}

const POLL_INTERVAL_MS = 2500
// 10 minutes. The old 3-minute ceiling assumed a 30-90s sync, which only
// holds when hospitableApiLimiter's shared platform budget is uncontended.
// Two orgs connecting in the same window push a 50-property initial sync
// well past three minutes, and the timeout was firing on a sync that was
// still running perfectly well — showing an error to a customer on their
// very first screen.
const SYNC_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Polls sync progress while a connection is active but has no terminal result
 * yet. Starts immediately after the OAuth redirect (metadata has no
 * last_sync_status yet) and also picks up if the user navigates here mid-sync.
 */
function useSyncProgress(
  providerId: string,
  connection: Connection | null,
  enabled:    boolean,
): SyncState {
  const initialMeta       = asJsonObject(connection?.metadata) ?? {}
  const initialSyncStatus = typeof initialMeta.last_sync_status === 'string'
    ? initialMeta.last_sync_status
    : null
  const initiallyTerminal = initialSyncStatus === 'success' || initialSyncStatus === 'error'

  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [syncTimedOut,  setSyncTimedOut] = useState(false)
  const [pollError,     setPollError]    = useState<string | null>(null)

  const status = syncProgress?.lastSyncStatus ?? initialSyncStatus
  const propertiesFound = syncProgress?.propertiesFound
    ?? (typeof initialMeta.properties_found === 'number' ? initialMeta.properties_found : null)
  const bookingsFound = syncProgress?.bookingsFound
    ?? (typeof initialMeta.bookings_found === 'number' ? initialMeta.bookings_found : null)

  const isTerminal = status === 'success' || status === 'error'
  // `enabled` is false for a manage-only provider: it has no sync to report
  // progress on, so the poll would run every 2.5s for the full 10-minute
  // SYNC_TIMEOUT_MS and then render a timeout error for a connection that is
  // behaving exactly as intended.
  const shouldPoll = enabled && connection?.status === 'active' && !initiallyTerminal && !isTerminal && !syncTimedOut

  useEffect(() => {
    if (!shouldPoll) return

    const startedAt = Date.now()

    const poll = async () => {
      if (Date.now() - startedAt > SYNC_TIMEOUT_MS) {
        setSyncTimedOut(true)
        clearInterval(intervalId)
        return
      }
      try {
        const progress = await getSyncProgress(providerId)
        if (!progress) return
        setPollError(null)
        setSyncProgress(progress)
        if (progress.lastSyncStatus === 'success' || progress.lastSyncStatus === 'error') {
          clearInterval(intervalId)
        }
      } catch (err) {
        // Keep polling — a single failed poll is usually transient — but the
        // error must not vanish. Swallowing it silently meant the user only
        // ever saw the timeout message, never the actual cause (a revoked
        // token, a 500 from the provider), and neither did Sentry.
        console.error('[IntegrationCard] sync progress poll failed', err)
        reportError(err, {
          site: 'client.integrations.syncProgressPoll',
          extra: { provider_id: providerId },
        })
        setPollError('We’re having trouble checking sync progress. Still retrying…')
      }
    }

    poll()
    const intervalId = setInterval(poll, POLL_INTERVAL_MS)

    return () => clearInterval(intervalId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.status, initiallyTerminal, providerId, enabled])

  return { status, propertiesFound, bookingsFound, isTerminal, timedOut: syncTimedOut, pollError }
}

// ── Card sub-views ───────────────────────────────────────────────────────────

function ConnectButton({
  provider,
  label,
  onConnectClick,
}: Readonly<{ provider: Provider; label: string; onConnectClick: () => void }>) {
  if (provider.auth_type === 'api_key') {
    return (
      <Button variant="secondary" onClick={onConnectClick} className="text-sm flex items-center gap-1.5">
        <PlugZap className="w-3.5 h-3.5" />
        {label}
      </Button>
    )
  }

  const href = provider.id === 'ownerrez'
    ? `/api/integrations/${provider.id}/connect?return_to=${encodeURIComponent('/ops')}`
    : `/api/integrations/${provider.id}/connect`

  return (
    <a href={href} className={buttonVariantClass('secondary') + ' text-sm flex items-center gap-1.5'}>
      <PlugZap className="w-3.5 h-3.5" />
      {label}
    </a>
  )
}

function SyncInProgress({ sync }: Readonly<{ sync: SyncState }>) {
  const message = sync.timedOut
    // Reassurance, not an error — a large portfolio can genuinely still be
    // syncing well past 10 minutes when the shared Hospitable rate-limit
    // budget is contended by other orgs connecting at the same time. No
    // promise of a completion email here: the only Hospitable-connected
    // notification fires at OAuth-callback time (in parallel with the sync
    // starting), not on sync completion — see email-hospitable-connected.tsx.
    ? 'Still working. Large portfolios can take several minutes — check back here shortly.'
    : getSyncCopy(sync.propertiesFound, sync.bookingsFound)

  return (
    <div className="flex items-center gap-2 py-1">
      {!sync.timedOut && (
        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
      )}
      <span className="text-xs max-w-[220px] text-right" style={{ color: 'var(--text-muted)' }}>
        {message}
      </span>
    </div>
  )
}

function DisconnectConfirm({
  disconnecting,
  onConfirm,
  onCancel,
}: Readonly<{ disconnecting: boolean; onConfirm: () => void; onCancel: () => void }>) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Disconnect?</span>
      <Button variant="danger" onClick={onConfirm} disabled={disconnecting} className="text-xs py-1.5 px-2.5">
        {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Yes, disconnect'}
      </Button>
      <Button variant="ghost" onClick={onCancel} className="text-xs py-1.5">Cancel</Button>
    </div>
  )
}

function ConnectedActions({
  resyncing,
  canDisconnect,
  onResync,
  onDisconnectClick,
}: Readonly<{
  resyncing: boolean
  canDisconnect: boolean
  /** Omitted for a provider with no sync — the button is not rendered at all. */
  onResync: (() => void) | null
  onDisconnectClick: () => void
}>) {
  return (
    <div className="flex items-center gap-2">
      {onResync && (
      <Button
        variant="ghost"
        onClick={onResync}
        disabled={resyncing}
        className="text-sm flex items-center gap-1.5"
        style={{ color: 'var(--text-muted)' }}
        title="Manually re-run this integration's sync"
      >
        {resyncing
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RefreshCw className="w-3.5 h-3.5" />}
        Trigger Resync
      </Button>
      )}
      {canDisconnect && (
        <Button
          variant="ghost"
          onClick={onDisconnectClick}
          className="text-sm flex items-center gap-1.5"
          style={{ color: 'var(--text-muted)' }}
        >
          <Unplug className="w-3.5 h-3.5" />
          Disconnect
        </Button>
      )}
    </div>
  )
}

interface CardStatus {
  isConnected:      boolean
  isError:          boolean
  isDisconnected:   boolean
  isSyncInProgress: boolean
}

function deriveCardStatus(connection: Connection | null, syncStatus: string | null): CardStatus {
  const isConnected = connection?.status === 'active' && syncStatus === 'success'
  const isError =
    connection?.status === 'error' ||
    connection?.status === 'revoked' ||
    syncStatus === 'error'
  // Deliberate disconnect — NOT an error. Show a plain Connect button with
  // no red badge and no "token revoked" messaging.
  const isDisconnected = connection?.status === 'disconnected'
  return {
    isConnected,
    isError,
    isDisconnected,
    isSyncInProgress: connection?.status === 'active' && !isConnected && !isError,
  }
}

function IntegrationDetails({
  provider,
  connection,
  status,
  error,
  resyncMessage,
  pollError,
  manageOnly,
}: Readonly<{
  provider: Provider
  connection: Connection | null
  status: CardStatus
  error: string | null
  resyncMessage: string | null
  pollError: string | null
  manageOnly: boolean
}>) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
          {provider.display_name}
        </h3>
        {!manageOnly && status.isConnected && <Badge tone="green" className="text-xs">Connected</Badge>}
        {manageOnly  && connection          && <Badge tone="slate" className="text-xs">Authorized</Badge>}
        {status.isError     && <Badge tone="red"   className="text-xs">Error</Badge>}
      </div>

      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
        {PROVIDER_DESCRIPTIONS[provider.id] ?? ''}
      </p>

      {(status.isConnected || manageOnly) && connection && (
        <div className="text-xs space-y-0.5 mt-1.5" style={{ color: 'var(--text-muted)' }}>
          {connection.external_user_id && <p>Account ID: {connection.external_user_id}</p>}
          <p>Connected {formatDate(connection.created_at)}</p>
        </div>
      )}

      {status.isError && (
        <p className="text-xs mt-1" style={{ color: 'var(--accent-red)' }}>
          Token revoked or expired. Reconnect to restore sync.
        </p>
      )}

      {status.isDisconnected && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Disconnected.</p>
      )}

      {error && <p className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}

      {pollError && (
        <p className="text-xs mt-2" role="alert" style={{ color: 'var(--accent-amber)' }}>{pollError}</p>
      )}

      {resyncMessage && (
        <p
          className="text-xs mt-2"
          style={{ color: resyncMessage === 'Resync started.' ? 'var(--accent-green)' : 'var(--accent-red)' }}
        >
          {resyncMessage}
        </p>
      )}
    </div>
  )
}

function IntegrationCard({
  provider,
  connection,
  onConnectClick,
  canDisconnect,
}: Readonly<{
  provider:       Provider
  connection:     Connection | null
  onConnectClick: () => void
  canDisconnect:  boolean
}>) {
  const [disconnecting, startDisconnect] = useTransition()
  const [confirming, setConfirming]      = useState(false)
  const [error, setError]                = useState<string | null>(null)
  const [resyncing, startResync]         = useTransition()
  const [resyncMessage, setResyncMessage] = useState<string | null>(null)

  // A provider this org is connected to but that is not offered for new
  // connections — is_active = false (Hostex during its phased rollout) or on
  // HIDDEN_PROVIDER_IDS. page.tsx only sends one of these when a connection
  // exists, so the card's whole job here is to make that connection visible
  // and removable: no Connect, no Resync, no sync-progress poll.
  const manageOnly = !provider.is_active || HIDDEN_PROVIDER_IDS.has(provider.id)

  const sync   = useSyncProgress(provider.id, connection, !manageOnly)
  const status = deriveCardStatus(connection, sync.status)

  const handleDisconnect = () => {
    startDisconnect(async () => {
      const result = await disconnectIntegration(provider.id)
      if (result.error) setError(result.error)
      else setConfirming(false)
    })
  }

  const handleResync = () => {
    setResyncMessage(null)
    startResync(async () => {
      const result = await triggerResync(provider.id)
      setResyncMessage(result.error ?? 'Resync started.')
    })
  }

  const needsConnect = !connection || status.isError || status.isDisconnected

  const renderActions = () => {
    // Checked before everything else. Without sync progress this connection
    // never reaches isConnected, so it would otherwise fall into
    // isSyncInProgress and spin for ten minutes before showing a timeout.
    if (manageOnly) {
      if (confirming) {
        return (
          <DisconnectConfirm
            disconnecting={disconnecting}
            onConfirm={handleDisconnect}
            onCancel={() => setConfirming(false)}
          />
        )
      }
      return (
        <ConnectedActions
          resyncing={false}
          canDisconnect={canDisconnect}
          onResync={null}
          onDisconnectClick={() => setConfirming(true)}
        />
      )
    }
    if (status.isSyncInProgress) return <SyncInProgress sync={sync} />
    if (needsConnect) {
      return (
        <ConnectButton
          provider={provider}
          label={status.isError || status.isDisconnected ? 'Reconnect' : 'Connect'}
          onConnectClick={onConnectClick}
        />
      )
    }
    if (confirming) {
      return (
        <DisconnectConfirm
          disconnecting={disconnecting}
          onConfirm={handleDisconnect}
          onCancel={() => setConfirming(false)}
        />
      )
    }
    return (
      <ConnectedActions
        resyncing={resyncing}
        canDisconnect={canDisconnect}
        onResync={handleResync}
        onDisconnectClick={() => setConfirming(true)}
      />
    )
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <IntegrationDetails
          provider={provider}
          connection={connection}
          status={status}
          error={error}
          resyncMessage={resyncMessage}
          pollError={sync.pollError}
          manageOnly={manageOnly}
        />
        <div className="flex-shrink-0">{renderActions()}</div>
      </div>
    </Card>
  )
}
