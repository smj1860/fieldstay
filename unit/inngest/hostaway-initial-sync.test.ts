import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

// ============================================================================
// hostawayInitialSync is now ORCHESTRATION: read a token, map listings through
// upsertNormalizedProperties, seed checklists, hand reservations to the shared
// pipeline, sync the guidebook, mark complete. The mapping judgment lives in
// unit/integrations/hostaway-mappers.test.ts and the write behaviour is covered
// where the shared writers are tested.
//
// So this file asserts the things only the orchestration can get wrong — the
// ones that would compile perfectly and still be defects:
//
//   - going through the SHARED property writer rather than a raw upsert (the
//     2026-07-25 version's hand-rolled one invented room counts and kept no
//     content-overwrite audit trail)
//   - revenueMode 'all', without which no revenue reaches owner_transactions —
//     the documented reason Hostaway was switched off
//   - 12 months of history, since Hostaway's /reservations defaults to 90 days
//   - a missing token failing NON-retriably
//   - a failure still recording last_sync_error for the PM
// ============================================================================

vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hostaway', () => ({
  hostawayFetchListings: vi.fn(),
}))
vi.mock('@/lib/properties/upsert-normalized', () => ({
  upsertNormalizedProperties: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/shared/property-onboarding', () => ({
  applyChecklistsToProperties: vi.fn(),
  syncGuidebookForOrg:        vi.fn(),
}))
vi.mock('@/lib/inngest/functions/hostaway/reservation-sync', () => ({
  syncHostawayReservations: vi.fn(),
}))
vi.mock('@/lib/integrations/connection-metadata', () => ({
  mergeIntegrationConnectionMetadata: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { hostawayInitialSync } from '@/lib/inngest/functions/hostaway/initial-sync'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { hostawayFetchListings } from '@/lib/integrations/providers/hostaway'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyChecklistsToProperties, syncGuidebookForOrg } from '@/lib/inngest/functions/shared/property-onboarding'
import { syncHostawayReservations } from '@/lib/inngest/functions/hostaway/reservation-sync'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { invokeHandler } from './test-helpers'

const EVENT_DATA = {
  user_id:     'user_1',
  org_id:      'org_1',
  provider_id: 'hostaway',
  full_sync:   true,
}

/** Runs every step.run() body for real; the module mocks drive the rest. */
function makeRunAllStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep:     vi.fn(),
    sendEvent: vi.fn(),
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function run() {
  return invokeHandler(hostawayInitialSync, {
    event:  { data: EVENT_DATA },
    step:   makeRunAllStep(),
    logger: makeLogger(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock(readIntegrationToken).mockResolvedValue('token_abc')
  mock(hostawayFetchListings).mockResolvedValue([
    { id: 101, name: 'A' },
    { id: 102, name: 'B' },
  ])
  mock(upsertNormalizedProperties).mockResolvedValue({ '101': 'uuid-101', '102': 'uuid-102' })
  mock(syncHostawayReservations).mockResolvedValue({ reservationCount: 7, newTurnoverIds: [] })
  mock(mergeIntegrationConnectionMetadata).mockResolvedValue({})
})

describe('hostawayInitialSync', () => {
  it('imports properties through the SHARED normalized writer', async () => {
    await run()

    expect(upsertNormalizedProperties).toHaveBeenCalledTimes(1)
    const [orgId, provider, normalized] = mock(upsertNormalizedProperties).mock.calls[0]
    expect(orgId).toBe('org_1')
    expect(provider).toBe('hostaway')
    // Mapped, not raw listings — the raw shape has `id`, the normalized one
    // has `external_id` and nullable room counts.
    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toMatchObject({ external_id: '101', bedrooms: null })
  })

  it("posts revenue with revenueMode 'all' — the reason it was switched off", async () => {
    await run()

    expect(syncHostawayReservations).toHaveBeenCalledTimes(1)
    const params = mock(syncHostawayReservations).mock.calls[0][0]
    // 'all' rather than 'new-only': the post is idempotent, and firing broadly
    // is what lets a manual resync REPAIR an org whose revenue post failed.
    expect(params.revenueMode).toBe('all')
    expect(params.propertyIdMap).toEqual({ '101': 'uuid-101', '102': 'uuid-102' })
  })

  it('asks for 12 months of history, not Hostaway\'s 90-day default', async () => {
    await run()

    const params = mock(syncHostawayReservations).mock.calls[0][0]
    expect(params.fetchMode).toEqual({ kind: 'window', historyMonths: 12 })
  })

  it('seeds checklists and guidebook config so imported properties are not inert', async () => {
    await run()

    expect(applyChecklistsToProperties).toHaveBeenCalledWith(
      expect.anything(), 'org_1', ['uuid-101', 'uuid-102'], expect.any(String),
    )
    expect(syncGuidebookForOrg).toHaveBeenCalledTimes(1)
  })

  it('records success metadata with the counts the PM sees', async () => {
    const result = await run()

    expect(result).toEqual({ properties: 2, reservations: 7 })
    expect(mergeIntegrationConnectionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:     'user_1',
        providerId: 'hostaway',
        patch: expect.objectContaining({
          last_sync_status: 'success',
          last_sync_error:  null,
          properties_found: 2,
          bookings_found:   7,
        }),
      }),
    )
  })

  it('skips the property writer entirely when the account has no listings', async () => {
    mock(hostawayFetchListings).mockResolvedValue([])

    const result = await run()

    expect(upsertNormalizedProperties).not.toHaveBeenCalled()
    expect(result).toEqual({ properties: 0, reservations: 7 })
  })

  it('fails NON-retriably when there is no token', async () => {
    mock(readIntegrationToken).mockResolvedValue(null)

    // The TYPE is the assertion, not the message. Retrying cannot conjure a
    // token — only reconnecting can — so this function is configured with
    // retries: 4 and must opt out for this one case. A plain Error satisfies
    // any message matcher while still burning all four retries, which is
    // exactly what a message-only assertion here failed to catch.
    await expect(run()).rejects.toBeInstanceOf(NonRetriableError)
    expect(hostawayFetchListings).not.toHaveBeenCalled()
  })

  it('records last_sync_error and rethrows when the fetch fails', async () => {
    mock(hostawayFetchListings).mockRejectedValue(new Error('Hostaway listings fetch failed (401)'))

    await expect(run()).rejects.toThrow(/401/)

    // The PM-visible half: without this the connection looks healthy while
    // nothing syncs.
    expect(mergeIntegrationConnectionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        patch:  expect.objectContaining({ last_sync_status: 'error' }),
      }),
    )
  })
})
