// Regression: a vendor's queued completion that the server TERMINALLY rejects
// must dead-letter — visibly, immediately, and with the specific reason — while
// a transport failure must retry forever and never dead-letter.
//
// e2e/specs/21-work-order-offline.spec.ts:164 covers the pairing end to end:
// the vendor submits offline, someone else closes the work order through
// another path, connectivity returns, and the portal must show "Not Submitted"
// / "already closed" with NO retry affordance (retrying a closed WO can never
// succeed). It regressed on the reconnect path: the queued submission is
// sitting on a transport-failure backoff — set by the very outage that queued
// it — so the drain the `online` handler awaits stopped at the backoff gate
// and did nothing. The portal then read the mutation as "still queued", and
// the eventual timer-driven dead-letter happened in the background with
// nothing listening, so the rejection never reached the vendor's screen.
//
// Runs against real (fake-indexeddb) IndexedDB through the actual
// vendorWoSyncService, so the HTTP status → classification → dead-letter path
// is exercised exactly as it is in the browser.

import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  submitVendorWoCompletion,
  retryVendorWoSubmission,
  getVendorWoSubmissionState,
} from '@/lib/dexie/vendorWoSyncService'
import { getVendorWoDb } from '@/lib/dexie/vendorWoSchema'

const LINE_ITEMS = [
  { line_type: 'material', description: 'Replaced valve', quantity: 1, unit_cost: 125, line_total: 125 },
]

let token: string
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The transport failure a dropped/blocked request produces in the browser. */
function transportFailure(): Promise<never> {
  return Promise.reject(new TypeError('Failed to fetch'))
}

async function queueOfflineSubmission(): Promise<void> {
  fetchMock.mockImplementation(transportFailure)
  const { synced } = await submitVendorWoCompletion(token, 'notes', 'Tech', LINE_ITEMS, 125)
  expect(synced).toBe(false)
}

beforeEach(() => {
  token = `e2e-${Math.abs(Date.now() % 1_000_000)}-${globalThis.crypto.randomUUID()}`
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await getVendorWoDb(token).delete()
})

describe('vendor completion outbox — terminal vs. transport failures', () => {
  it('dead-letters a terminal server rejection as soon as connectivity returns', async () => {
    await queueOfflineSubmission()

    const queued = await getVendorWoSubmissionState(token)
    expect(queued?.failed).toBeFalsy()
    // The outage stamped a backoff window on the row — this is what the
    // reconnect drain used to stop on.
    expect(queued?.nextAttemptAt).toBeGreaterThan(Date.now())

    // The WO was closed through another path while the vendor was offline.
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'Work order already closed' }))

    // Connectivity returns — this is the portal's `online` handler, and the
    // state it reads the instant this resolves is what it renders.
    await retryVendorWoSubmission(token)

    const after = await getVendorWoSubmissionState(token)
    expect(after?.failed).toBe(true)
    expect(after?.terminalReason).toBe('closed')   // drives "Not Submitted" + "already closed"
    expect(fetchMock).toHaveBeenCalledTimes(2)     // the offline attempt, then exactly one more
  })

  it('does not burn the retry budget on a terminal rejection', async () => {
    await queueOfflineSubmission()
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'Work order already closed' }))

    await retryVendorWoSubmission(token)

    const after = await getVendorWoSubmissionState(token)
    // Dead-lettered on the first server rejection, not after five attempts.
    expect(after?.retryCount).toBe(0)
  })

  it('dead-letters an expired completion link with its own reason', async () => {
    await queueOfflineSubmission()
    fetchMock.mockResolvedValue(jsonResponse(410, { error: 'Link has expired' }))

    await retryVendorWoSubmission(token)

    const after = await getVendorWoSubmissionState(token)
    expect(after?.failed).toBe(true)
    expect(after?.terminalReason).toBe('expired')
  })

  it('never dead-letters a transport failure, however many reconnects it takes', async () => {
    await queueOfflineSubmission()

    // Every reconnect finds the network still broken.
    for (let i = 0; i < 8; i++) {
      await retryVendorWoSubmission(token)
      const row = await getVendorWoSubmissionState(token)
      expect(row?.failed).toBeFalsy()          // launch blocker: offline work is never thrown away
      expect(row?.retryCount).toBe(0)          // a failed transport attempt costs no retry budget
      expect(row?.terminalReason).toBeUndefined()
    }

    expect(await getVendorWoSubmissionState(token)).toBeDefined()

    // …and it still syncs the moment the network genuinely comes back.
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))
    await retryVendorWoSubmission(token)
    expect(await getVendorWoSubmissionState(token)).toBeUndefined()
  })

  it('a reconnect drains despite the outage backoff instead of waiting it out', async () => {
    await queueOfflineSubmission()

    const beforeAttempts = fetchMock.mock.calls.length
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))

    await retryVendorWoSubmission(token)

    expect(fetchMock.mock.calls.length).toBe(beforeAttempts + 1)
    expect(await getVendorWoSubmissionState(token)).toBeUndefined()
  })
})
