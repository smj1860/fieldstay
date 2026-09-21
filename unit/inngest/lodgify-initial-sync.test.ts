import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// ============================================================================
// lodgifyInitialSync is ORCHESTRATION: read the key, map properties through
// upsertNormalizedProperties, seed checklists, hand bookings to the shared
// pipeline, register webhooks, sync the guidebook, mark complete. The mapping
// judgment lives in unit/integrations/lodgify-mappers.test.ts.
//
// So this file asserts only what the orchestration itself can get wrong — the
// defects that compile perfectly:
//
//   - going through the SHARED property writer rather than a raw upsert (the
//     hand-rolled version one provider over invented room counts and kept no
//     content-overwrite audit trail)
//   - revenueMode 'all', without which a resync cannot REPAIR an org whose
//     revenue post failed the first time
//   - 12 months of history, since an unparameterised Lodgify read returns
//     whatever default slice Lodgify chooses
//   - excluding delisted properties, but ONLY on an explicit is_active: false
//   - a missing key failing NON-retriably
//   - webhook registration staying non-fatal — it is gated OFF by default, and
//     a failure there must never cost the import that already succeeded
//   - a failure still recording last_sync_error for the PM
// ============================================================================

vi.mock('@/lib/integrations/vault', () => ({ readIntegrationToken: vi.fn() }))
vi.mock('@/lib/integrations/providers/lodgify-api', () => ({ lodgifyFetchProperties: vi.fn() }))
vi.mock('@/lib/integrations/providers/lodgify-webhook', () => ({ ensureLodgifyWebhookRegistration: vi.fn() }))
vi.mock('@/lib/properties/upsert-normalized', () => ({ upsertNormalizedProperties: vi.fn() }))
vi.mock('@/lib/inngest/functions/shared/property-onboarding', () => ({
  applyChecklistsToProperties: vi.fn(),
  syncGuidebookForOrg:         vi.fn(),
}))
vi.mock('@/lib/inngest/functions/lodgify/reservation-sync', () => ({ syncLodgifyReservations: vi.fn() }))
vi.mock('@/lib/integrations/connection-metadata', () => ({ mergeIntegrationConnectionMetadata: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { lodgifyInitialSync } from '@/lib/inngest/functions/lodgify/initial-sync'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { lodgifyFetchProperties } from '@/lib/integrations/providers/lodgify-api'
import { ensureLodgifyWebhookRegistration } from '@/lib/integrations/providers/lodgify-webhook'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyChecklistsToProperties } from '@/lib/inngest/functions/shared/property-onboarding'
import { syncLodgifyReservations } from '@/lib/inngest/functions/lodgify/reservation-sync'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { invokeHandler } from './test-helpers'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function run() {
  return invokeHandler(lodgifyInitialSync, {
    event:  { data: { user_id: 'user_1', org_id: 'org_1', external_user_id: '42' } },
    step:   { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn(), sleep: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('api-key')
  mock(lodgifyFetchProperties).mockResolvedValue([
    { id: 42, name: 'Lakefront Cabin' },
    { id: 43, name: 'Ridge House' },
  ])
  mock(upsertNormalizedProperties).mockResolvedValue({ '42': 'uuid-42', '43': 'uuid-43' })
  mock(syncLodgifyReservations).mockResolvedValue({ reservationCount: 9, newTurnoverIds: ['t1'] })
  mock(ensureLodgifyWebhookRegistration).mockResolvedValue({ attempted: false, created: 0, reason: 'disabled' })
  mock(mergeIntegrationConnectionMetadata).mockResolvedValue({})
})

describe('properties', () => {
  it('imports through the SHARED normalized writer', async () => {
    await run()

    const [orgId, provider, normalized] = mock(upsertNormalizedProperties).mock.calls[0]!
    expect(orgId).toBe('org_1')
    expect(provider).toBe('lodgify')
    // Mapped, not raw: the raw shape has `id`, the normalized one has
    // `external_id` and nullable room counts.
    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toMatchObject({ external_id: '42', bedrooms: null })
  })

  it('excludes a property Lodgify marks inactive', async () => {
    mock(lodgifyFetchProperties).mockResolvedValue([
      { id: 42, name: 'Live' },
      { id: 99, name: 'Delisted', is_active: false },
    ])

    await run()
    const [, , normalized] = mock(upsertNormalizedProperties).mock.calls[0]!
    expect(normalized.map((p: { external_id: string }) => p.external_id)).toEqual(['42'])
  })

  it('imports a property that says NOTHING about is_active', async () => {
    // Absence means "Lodgify did not tell us". Treating it as inactive would
    // import zero properties from an account whose response differs by one
    // field name — a total failure that reads as "this PM has no listings".
    mock(lodgifyFetchProperties).mockResolvedValue([{ id: 42, name: 'No flag' }])

    await run()
    expect(mock(upsertNormalizedProperties).mock.calls[0]![2]).toHaveLength(1)
  })

  it('seeds checklists for the imported properties', async () => {
    await run()
    const [, , propertyIds] = mock(applyChecklistsToProperties).mock.calls[0]!
    expect(propertyIds).toEqual(['uuid-42', 'uuid-43'])
  })

  it('skips the upsert entirely for an account with no properties', async () => {
    mock(lodgifyFetchProperties).mockResolvedValue([])

    await expect(run()).resolves.toMatchObject({ properties: 0 })
    expect(upsertNormalizedProperties).not.toHaveBeenCalled()
  })
})

describe('bookings', () => {
  it("posts revenue with revenueMode 'all' so a resync REPAIRS a failed post", async () => {
    await run()
    expect(mock(syncLodgifyReservations).mock.calls[0]![0].revenueMode).toBe('all')
  })

  it('pulls 12 months of history and 6 forward', async () => {
    await run()
    expect(mock(syncLodgifyReservations).mock.calls[0]![0].fetchMode)
      .toEqual({ kind: 'window', historyMonths: 12, lookaheadMonths: 6 })
  })
})

describe('webhook registration', () => {
  it('is attempted AFTER properties exist', async () => {
    // A delivery arriving before the property map exists is skipped as an
    // unknown property, so registering first would guarantee a window where
    // real booking events are dropped.
    const order: string[] = []
    mock(upsertNormalizedProperties).mockImplementation(async () => { order.push('properties'); return { '42': 'uuid-42' } })
    mock(ensureLodgifyWebhookRegistration).mockImplementation(async () => { order.push('webhook'); return { attempted: false, created: 0 } })

    await run()
    expect(order).toEqual(['properties', 'webhook'])
  })

  it('does not fail the sync when registration throws', async () => {
    mock(ensureLodgifyWebhookRegistration).mockRejectedValue(new Error('Lodgify 503'))

    await expect(run()).resolves.toMatchObject({ properties: 2, reservations: 9 })
  })
})

describe('failure handling', () => {
  it('fails NON-retriably when no API key is stored', async () => {
    mock(readIntegrationToken).mockResolvedValue(null)

    await expect(run()).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('records a PM-readable last_sync_error and flips the connection to error', async () => {
    mock(lodgifyFetchProperties).mockRejectedValue(new Error('HTTP 401 unauthorized'))

    await expect(run()).rejects.toThrow()

    const patch = mock(mergeIntegrationConnectionMetadata).mock.calls.at(-1)![0]
    expect(patch).toMatchObject({ providerId: 'lodgify', status: 'error' })
    expect(patch.patch.last_sync_status).toBe('error')
    // translateSyncError's wording, not the raw provider text.
    expect(patch.patch.last_sync_error).toContain('Lodgify')
  })

  it('marks a successful run complete with what it found', async () => {
    await run()

    const patch = mock(mergeIntegrationConnectionMetadata).mock.calls.at(-1)![0]
    expect(patch.patch).toMatchObject({
      last_sync_status: 'success',
      last_sync_error:  null,
      properties_found: 2,
      bookings_found:   9,
    })
  })
})
