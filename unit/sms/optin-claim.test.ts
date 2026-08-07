import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import {
  claimDailySmsSlot,
  releaseDailySmsSlot,
  sendClaimedDailySms,
} from '@/lib/sms/optin-claim'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Minimal `.from(table)` chain. Every terminal (`maybeSingle`, or awaiting the
 * builder directly) consumes the next queued result in call order, so the claim
 * UPDATE and the release UPDATE can be scripted independently.
 */
function makeSupabase(queued: { data?: unknown; error?: unknown }[]) {
  let idx = 0
  const calls: { method: string; args: unknown[] }[] = []

  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.or     = (...a: unknown[]) => record('or', a)
    chain.select = (...a: unknown[]) => record('select', a)

    const resolveNext = () => Promise.resolve(queued[idx++] ?? { data: null, error: null })
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { client: { from } as unknown as SupabaseClient, calls }
}

const CLAIM_WON  = { data: { id: 'optin_1' }, error: null }
const CLAIM_LOST = { data: null, error: null }
const NO_ROWS    = { data: null, error: null }

describe('claimDailySmsSlot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns true when this call won the atomic claim', async () => {
    const { client } = makeSupabase([CLAIM_WON])
    await expect(
      claimDailySmsSlot(client, 'optin_1', 'last_morning_sms_date', '2026-08-07')
    ).resolves.toBe(true)
  })

  it('returns false — not an error — when a prior run already claimed today', async () => {
    const { client } = makeSupabase([CLAIM_LOST])
    await expect(
      claimDailySmsSlot(client, 'optin_1', 'last_morning_sms_date', '2026-08-07')
    ).resolves.toBe(false)
  })

  it('throws when the claim query itself fails, instead of reading it as already-sent', async () => {
    // A failed claim returns null data too. Reporting that as false told every
    // caller "already sent today" and suppressed the guest's SMS silently.
    const { client } = makeSupabase([{ data: null, error: { message: 'deadlock detected', code: '40P01' } }])
    await expect(
      claimDailySmsSlot(client, 'optin_1', 'last_morning_sms_date', '2026-08-07')
    ).rejects.toThrow(/Supabase query failed/)
  })
})

describe('sendClaimedDailySms', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends and keeps the claim on success', async () => {
    const { client, calls } = makeSupabase([CLAIM_WON])
    const send = vi.fn(async () => ({ sent: true }))

    await expect(
      sendClaimedDailySms(client, 'optin_1', 'last_morning_sms_date', '2026-08-07', send)
    ).resolves.toBe(true)

    expect(send).toHaveBeenCalled()
    // Exactly one UPDATE: the claim. No release.
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(1)
  })

  it('never calls send when the claim was already taken', async () => {
    const { client } = makeSupabase([CLAIM_LOST])
    const send = vi.fn(async () => ({ sent: true }))

    await expect(
      sendClaimedDailySms(client, 'optin_1', 'last_evening_sms_date', '2026-08-07', send)
    ).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  // The two failure exits below are NOT the same event, and only one of them
  // was handled at the three call sites this helper replaced. sendSMS returns
  // {sent:false} ONLY for a deliberate skip (SMS_ENABLED off, nudge budget,
  // demo suppression); every real failure THROWS out of dispatchToTelnyx.
  it('releases the slot and rethrows when the send throws, so the day is not burned', async () => {
    const { client, calls } = makeSupabase([CLAIM_WON, NO_ROWS])
    const send = vi.fn(async () => { throw new Error('Telnyx 502') })

    await expect(
      sendClaimedDailySms(client, 'optin_1', 'last_morning_sms_date', '2026-08-07', send)
    ).rejects.toThrow('Telnyx 502')

    // Without the release the Inngest retry re-reads the date column, finds
    // today's date, skips — and that guest's nudge is gone for the day.
    const updates = calls.filter((c) => c.method === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1].args[0]).toEqual({ last_morning_sms_date: null })
  })

  it('releases the slot and returns false — without throwing — on a deliberate skip', async () => {
    const { client, calls } = makeSupabase([CLAIM_WON, NO_ROWS])
    const send = vi.fn(async () => ({ sent: false }))

    await expect(
      sendClaimedDailySms(client, 'optin_1', 'last_evening_sms_date', '2026-08-07', send)
    ).resolves.toBe(false)

    const updates = calls.filter((c) => c.method === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1].args[0]).toEqual({ last_evening_sms_date: null })
  })

  it('covers rendering too — a template failure inside send releases the slot', async () => {
    // Rendering used to sit BETWEEN the claim and the try-less send, so a
    // renderSmsBody throw burned the day's slot with no release at all.
    const { client, calls } = makeSupabase([CLAIM_WON, NO_ROWS])
    const send = vi.fn(async () => { throw new Error('unknown template key') })

    await expect(
      sendClaimedDailySms(client, 'optin_1', 'last_morning_sms_date', '2026-08-07', send)
    ).rejects.toThrow('unknown template key')
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(2)
  })
})

describe('releaseDailySmsSlot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('swallows a failed release rather than masking the original error', async () => {
    // Called from a catch block on the throw path — rethrowing here would
    // replace the real send failure with a rollback failure.
    const { client } = makeSupabase([{ data: null, error: { message: 'timeout', code: '57014' } }])
    await expect(
      releaseDailySmsSlot(client, 'optin_1', 'last_morning_sms_date')
    ).resolves.toBeUndefined()
  })
})
