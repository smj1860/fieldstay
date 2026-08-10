import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('resend', () => ({ Resend: class { emails = { send: vi.fn() } } }))

import { sendWithTimeout, ResendTimeoutError } from '@/lib/resend/client'
import { RESEND_TIMEOUT_MS } from '@/lib/http/timeout'

// ============================================================================
// Resend was the one outbound integration with no timeout at all.
// external-fetch-timeout.test.ts enforces a budget on every raw fetch(), but
// Resend goes through its SDK, so that guardrail could not see it — a slow
// Resend held the enclosing Inngest step open until the PLATFORM timeout
// killed the whole function.
//
// The audit that found this proposed `resend.emails.send(payload, { signal })`.
// That does not exist: Resend's PostOptions is `{ query?: … }` and the string
// "signal" appears nowhere in the published SDK, so the request cannot be
// cancelled — only stopped being waited on. Hence a race, and hence the
// idempotency-key requirement documented on sendWithTimeout.
// ============================================================================

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('sendWithTimeout', () => {
  it('returns the send result when it resolves inside the budget', async () => {
    const result = await sendWithTimeout(async () => ({ data: { id: 'em_1' }, error: null }))
    expect(result).toEqual({ data: { id: 'em_1' }, error: null })
  })

  it('rejects with ResendTimeoutError once the budget lapses', async () => {
    const promise = sendWithTimeout(() => new Promise(() => { /* never settles */ }))
    const assertion = expect(promise).rejects.toBeInstanceOf(ResendTimeoutError)
    await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS + 1)
    await assertion
  })

  it('does NOT time out a send that finishes just under the budget', async () => {
    const promise = sendWithTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve('ok'), RESEND_TIMEOUT_MS - 1)),
    )
    await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS - 1)
    await expect(promise).resolves.toBe('ok')
  })

  it('propagates a real send failure unchanged rather than masking it as a timeout', async () => {
    const boom = new Error('Resend 422')
    await expect(sendWithTimeout(async () => { throw boom })).rejects.toBe(boom)
  })

  it('clears the timer on the happy path — an uncleared one keeps the process alive for the full budget', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await sendWithTimeout(async () => 'ok')
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer when the send rejects too', async () => {
    await sendWithTimeout(async () => { throw new Error('x') }).catch(() => {})
    expect(vi.getTimerCount()).toBe(0)
  })
})
