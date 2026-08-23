import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DASHBOARD_UPLOAD_HANDLERS,
  SubmitRejectedError,
} from '@/lib/dexie/dashboard/syncService'
import type { DashboardMutationRow } from '@/lib/dexie/dashboard/schema'

// ============================================================================
// WHETHER A FAILED SUBMIT RETRIES OR DEAD-LETTERS IS THE WHOLE DECISION.
//
// The answers exist ONLY on the device until this handler succeeds, so both
// wrong answers cost real work:
//
//   retrying something permanent  — a deleted inspection, a malformed payload —
//     spins against a wall and never surfaces, so the PM believes it is sending.
//   dead-lettering something transient — a 500, a dropped connection at a
//     property — throws away a completed walk because the network blinked.
//
// The split is by status class, and `isTerminal` in the engine keys on the
// error TYPE, so the two have to agree.
// ============================================================================

const submit = DASHBOARD_UPLOAD_HANDLERS['inspection.submit']

const mutation = (over: Partial<DashboardMutationRow> = {}): DashboardMutationRow => ({
  id:         1,
  kind:       'inspection.submit',
  targetId:   'insp-1',
  orgId:      'org-1',
  payload:    { inspectorName: 'A. Inspector', items: [{ form_item_id: 'fi-1' }] },
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

describe('inspection.submit upload handler', () => {
  it('POSTs the queued payload to the inspection it belongs to', async () => {
    const fetchMock = mockFetch(200, { ok: true })
    await submit(mutation())

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/inspections/insp-1/submit')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      inspectorName: 'A. Inspector',
      items: [{ form_item_id: 'fi-1' }],
    })
  })

  it('resolves on success, so the drain deletes the row', async () => {
    mockFetch(200, { ok: true })
    await expect(submit(mutation())).resolves.toBeUndefined()
  })

  it('resolves on a REPLAY the server reports as already complete', async () => {
    // The idempotent path. The RPC returns ok for an inspection that is already
    // completed, precisely so a response lost in flight does not dead-letter a
    // submit that succeeded — and the handler must not undo that by treating
    // the second call as anything unusual.
    mockFetch(200, { ok: true, alreadyCompleted: true })
    await expect(submit(mutation())).resolves.toBeUndefined()
  })

  describe('4xx is terminal — retrying arrives at the same answer more slowly', () => {
    it('dead-letters a rejected payload, carrying the server’s reason', async () => {
      mockFetch(400, { error: 'An inspector name is required to sign off.' })
      await expect(submit(mutation())).rejects.toThrow(SubmitRejectedError)
      await expect(submit(mutation())).rejects.toThrow('An inspector name is required')
    })

    it('dead-letters a deleted inspection', async () => {
      mockFetch(404, { error: 'That inspection no longer exists.' })
      await expect(submit(mutation())).rejects.toThrow(SubmitRejectedError)
    })

    it('dead-letters a permission failure', async () => {
      mockFetch(403, { error: 'Not allowed.' })
      await expect(submit(mutation())).rejects.toThrow(SubmitRejectedError)
    })

    it('still fails usefully when the error body is not JSON', async () => {
      // An HTML error page from a proxy is a plausible 4xx body, and
      // `lastError` is what the banner shows a PM whose walk is stuck.
      mockFetch(400)
      await expect(submit(mutation())).rejects.toThrow(/rejected this submission \(400\)/)
    })
  })

  describe('5xx and transport failures stay retryable', () => {
    it('a 500 is NOT terminal', async () => {
      mockFetch(500, { error: 'Could not submit.' })
      // A plain Error, so `isTerminal` returns false and the drain retries.
      // SubmitRejectedError here would throw away a completed inspection
      // because the database hiccuped.
      await expect(submit(mutation())).rejects.not.toBeInstanceOf(SubmitRejectedError)
      await expect(submit(mutation())).rejects.toThrow('Submit failed with 500')
    })

    it('a 503 is NOT terminal', async () => {
      mockFetch(503)
      await expect(submit(mutation())).rejects.not.toBeInstanceOf(SubmitRejectedError)
    })

    it('a thrown fetch — no signal at the property — is NOT terminal', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
      await expect(submit(mutation())).rejects.not.toBeInstanceOf(SubmitRejectedError)
    })
  })
})
