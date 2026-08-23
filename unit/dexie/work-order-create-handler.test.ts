import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DASHBOARD_UPLOAD_HANDLERS,
  SubmitRejectedError,
} from '@/lib/dexie/dashboard/syncService'
import type { DashboardMutationRow } from '@/lib/dexie/dashboard/schema'

// ============================================================================
// THE LAST KIND TO GET A HANDLER.
//
// Until now `work_order.create` threw HandlerNotImplementedError: the endpoint
// had not shipped and a loud labelled throw beat a silent no-op. §8's reason
// for building it is about the job rather than the architecture — a PM standing
// at a property with no signal who notices a broken handrail wants to raise a
// work order, and "the inspection works offline but the work order does not" is
// a line drawn by us.
//
// Same decision as every other handler, and it is the whole decision: retry or
// dead-letter. Retrying something permanent spins against a wall and never
// surfaces, so the PM believes it is sending; dead-lettering something
// transient throws away a work order the tablet is the only copy of.
// ============================================================================

const create = DASHBOARD_UPLOAD_HANDLERS['work_order.create']

const mutation = (over: Partial<DashboardMutationRow> = {}): DashboardMutationRow => ({
  id:         1,
  kind:       'work_order.create',
  targetId:   'wo-local-1',
  orgId:      'org-1',
  payload: {
    id:          'wo-local-1',
    property_id: 'prop-1',
    title:       'Back door latch does not engage',
    priority:    'high',
  },
  createdAt:  '2026-08-23T10:00:00Z',
  retryCount: 0,
  ...over,
})

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok:     status >= 200 && status < 300,
    status,
    json:   () => (body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(body)),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

describe('work_order.create upload handler', () => {
  it('POSTs the queued payload, carrying the device-minted id', async () => {
    // That id is what the route upserts on, so a replay collides instead of
    // raising a second work order. Dropping it here would silently turn the
    // idempotency into nothing.
    const fetchMock = mockFetch(200, { ok: true })
    await create(mutation())

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/work-orders')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({
      id: 'wo-local-1', property_id: 'prop-1',
    })
  })

  it('posts to a ROUTE, never a Server Action', async () => {
    // §8: a queued row can outlive the release that wrote it — a tablet offline
    // across a deploy — and Server Action ids are not stable across builds, so
    // a replayed action 404s and dead-letters work that exists nowhere else.
    const fetchMock = mockFetch(200, { ok: true })
    await create(mutation())
    expect(fetchMock.mock.calls[0]![0]).toMatch(/^\/api\//)
  })

  it('resolves quietly when the server reports a duplicate', async () => {
    // The replay case. The route answers 200 with duplicate:true rather than a
    // conflict, because from the outbox's point of view the write succeeded —
    // and treating it as a failure would retry forever against a row that is
    // already there.
    mockFetch(200, { ok: true, duplicate: true })
    await expect(create(mutation())).resolves.toBeUndefined()
  })

  it('DEAD-LETTERS a 4xx, carrying the server reason', async () => {
    // A hard-blocked vendor or a property that is not this org's will not
    // become acceptable by retrying. The PM needs to be told why, and the
    // banner is where they are told.
    mockFetch(400, { error: 'That vendor is blocked for expired insurance.' })

    const err = await create(mutation()).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(SubmitRejectedError)
    expect((err as Error).message).toContain('blocked')
  })

  it('RETRIES a 5xx', async () => {
    // Until this lands the work order exists only on the tablet, so a server
    // blip must not be the thing that discards it.
    mockFetch(503)
    const err = await create(mutation()).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(SubmitRejectedError)
  })

  it('RETRIES a thrown fetch — the offline case it exists for', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await create(mutation()).then(() => null, (e: unknown) => e)
    expect(err).not.toBeInstanceOf(SubmitRejectedError)
  })

  it('falls back to a usable message when the 4xx body is not JSON', async () => {
    // A gateway's HTML error page must not surface to a PM as a parse failure,
    // and must not become the raw body either.
    mockFetch(422)
    const err = await create(mutation()).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(SubmitRejectedError)
    expect((err as Error).message).toContain('422')
  })
})
