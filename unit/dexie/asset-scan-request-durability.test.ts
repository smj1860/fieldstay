import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, makeFakeSupabase, type FakeDexieDb } from './fake-dexie'
import type { MutationRow } from '@/lib/dexie/schema'

// The data-plate scan request used to be a fire-and-forget fetch inside
// uploadPropertyAssetPhotoUpdate, with a bare `.catch(console.error)`. Because
// the handler still returned normally, pushOne() deleted the outbox row the
// moment the property_assets update landed — so a scan request lost to a
// dropped connection had no retry, no dead letter, and no banner entry. The
// crew member saw a saved asset and the scan simply never happened. That is
// precisely the silent loss the outbox exists to prevent, executed outside it.
//
// It is now awaited and its failure fails the mutation, which routes it
// through the machinery that already exists: classifyUploadFailure() treats
// 5xx/network as retryable and any other 4xx as terminal, and a dead letter
// surfaces under the property_assets entry of failed-sync-banner.tsx.
//
// Re-running the handler is safe in both directions: the property_assets
// update is idempotent (same photo_url), and the scan route skips an asset
// whose scan_status is already 'pending'/'processing' rather than burning a
// second billed Claude vision call.

const holder = vi.hoisted(() => ({
  db:       null as unknown,
  supabase: null as unknown,
}))

vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (holder.supabase as ReturnType<typeof makeFakeSupabase>).from(table),
  }),
}))

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { SyncEngine } from '@/lib/dexie/syncService'
import { reportError } from '@/lib/observability/report-error'

const NOW = Date.parse('2026-08-04T09:00:00.000Z')

function db(): FakeDexieDb { return holder.db as FakeDexieDb }
function mutationRow(id: number) {
  return db().mutations.get(id) as Promise<MutationRow | undefined>
}

/** The property_assets photo PATCH that carries a scan request. */
async function seedPhotoMutation(): Promise<number> {
  const id = await db().mutations.add({
    table:      'property_assets',
    targetId:   'asset_1',
    op:         'PATCH',
    payload:    {
      photo_url:   'org_1/assets/asset_1.jpg',
      scanRequest: { storagePath: 'org_1/assets/asset_1.jpg', mediaType: 'image/jpeg' },
    },
    createdAt:  new Date(NOW).toISOString(),
    retryCount: 0,
    failed: 0,
  })
  return id as number
}

function mockScanResponse(status: number) {
  // Typed args, not `async () => …`: the zero-arg form gives the mock a
  // zero-length tuple, so reading calls[0][1] to assert the AbortSignal is a
  // tsc error even though vitest runs it fine.
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function drain(): Promise<void> {
  await new SyncEngine('user_1').processOutbox()
}

describe('asset scan request — durability inside the outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    holder.db = makeFakeDexieDb()
    // The photo PATCH itself always succeeds; these tests are about what
    // happens to the scan request that follows it.
    holder.supabase = makeFakeSupabase({ property_assets: [{ data: [{ id: 'asset_1' }], error: null }] })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clears the outbox row once the scan request is accepted', async () => {
    const id = await seedPhotoMutation()
    const fetchMock = mockScanResponse(200)

    await drain()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await mutationRow(id)).toBeUndefined()
  })

  it('sends the scan request with a timeout budget, not an unbounded fetch', async () => {
    await seedPhotoMutation()
    const fetchMock = mockScanResponse(200)

    await drain()

    // An AbortSignal is the only thing that gives a fetch() a timeout at all;
    // without one the request can hang instead of rejecting, so even the old
    // .catch() would never have fired.
    const init = fetchMock.mock.calls[0]![1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('KEEPS the mutation queued when the scan request 500s — the regression', async () => {
    const id = await seedPhotoMutation()
    mockScanResponse(500)

    await drain()

    // Previously the row was deleted here and the scan was lost in silence.
    const row = await mutationRow(id)
    expect(row, 'a failed scan request must not vacate the outbox').toBeDefined()
    expect(row!.retryCount).toBe(1)
    expect(row!.failed).toBeFalsy()
  })

  it('dead-letters a 4xx rather than retrying a request replay cannot fix', async () => {
    const id = await seedPhotoMutation()
    // 400 = the route rejected the storage path as not matching the asset's
    // own photo_url. Replaying the identical body can only fail the same way.
    mockScanResponse(400)

    await drain()

    const row = await mutationRow(id)
    expect(row).toBeDefined()
    expect(row!.failed, 'a terminal rejection must dead-letter, not burn 5 retries').toBe(1)
  })

  it('treats a 429 scan cap as a completed sync, not a failed one', async () => {
    const id = await seedPhotoMutation()
    mockScanResponse(429)

    await drain()

    // The photo IS saved; only the optional AI scan is skipped by the daily
    // spend ceiling. Dead-lettering would tell a crew member their asset
    // didn't sync, which is false — but it must still be visible.
    expect(await mutationRow(id)).toBeUndefined()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'lib.dexie.syncService.scanRequest.rate_limited' }),
    )
  })

  it('does not fire a scan request for a photo PATCH that carries none', async () => {
    const id = await db().mutations.add({
      table:      'property_assets',
      targetId:   'asset_2',
      op:         'PATCH',
      payload:    { photo_url: 'org_1/assets/asset_2.jpg' },
      createdAt:  new Date(NOW).toISOString(),
      retryCount: 0,
    failed: 0,
  })
    const fetchMock = mockScanResponse(200)

    await drain()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await mutationRow(id as number)).toBeUndefined()
  })
})
