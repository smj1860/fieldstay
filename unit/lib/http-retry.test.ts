import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithRetry } from '@/lib/http/retry'

// ============================================================================
// P1-13. Retry is only correct for calls a duplicate cannot hurt, so these
// pin BOTH halves: that transient failures are retried, and that the things
// which must NOT be retried are not.
//
// The audit proposed adding backoff to all four integration clients. Two of
// them would be worse for it — Kroger sits behind a circuit breaker whose own
// comment says retrying "amplifies the outage", and Telnyx's send is a POST
// that texts a real guest on an ambiguous timeout. The last test here is the
// structural guard for that decision.
// ============================================================================

const OK  = () => new Response('{}', { status: 200 })
const S503 = () => new Response('nope', { status: 503 })
const S429 = () => new Response('slow down', { status: 429 })
const S400 = () => new Response('bad', { status: 400 })

const OPTS = { timeoutMs: 1_000, baseDelayMs: 1, label: 'test' }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchWithRetry', () => {
  it('returns a success without retrying', async () => {
    fetchMock.mockResolvedValue(OK())

    const res = await fetchWithRetry('https://x.test', {}, OPTS)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx and returns the eventual success', async () => {
    fetchMock.mockResolvedValueOnce(S503()).mockResolvedValueOnce(OK())

    const res = await fetchWithRetry('https://x.test', {}, OPTS)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a 429', async () => {
    fetchMock.mockResolvedValueOnce(S429()).mockResolvedValueOnce(OK())

    await fetchWithRetry('https://x.test', {}, OPTS)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 4xx — our request is wrong and waiting cannot fix it', async () => {
    fetchMock.mockResolvedValue(S400())

    const res = await fetchWithRetry('https://x.test', {}, OPTS)

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the final failing response rather than throwing on exhaustion', async () => {
    // The caller's existing status handling stays in charge. Synthesising a
    // throw here would mean every call site needs a second error path for the
    // case it already handles.
    fetchMock.mockResolvedValue(S503())

    const res = await fetchWithRetry('https://x.test', {}, { ...OPTS, attempts: 3 })

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transport error, then rethrows the REAL one on the last attempt', async () => {
    // Not a synthesised "retries exhausted" — the caller's isTimeoutError()
    // branch has to still be able to recognise what happened.
    const boom = new Error('ECONNREFUSED')
    fetchMock.mockRejectedValue(boom)

    await expect(fetchWithRetry('https://x.test', {}, { ...OPTS, attempts: 2 }))
      .rejects.toBe(boom)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives every attempt its OWN AbortSignal', async () => {
    // A signal created once and shared across attempts is already aborted by
    // the second one, so the retry fails instantly and looks like the provider
    // answering rather than like a timeout.
    fetchMock.mockResolvedValueOnce(S503()).mockResolvedValueOnce(OK())

    await fetchWithRetry('https://x.test', {}, OPTS)

    const signals = fetchMock.mock.calls.map((c) => c[1].signal)
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeDefined()
    expect(signals[0]).not.toBe(signals[1])
  })

  it('preserves caller init (headers, next) while owning the signal', async () => {
    fetchMock.mockResolvedValue(OK())

    await fetchWithRetry('https://x.test', { headers: { 'X-Test': '1' } }, OPTS)

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'X-Test': '1' } })
  })

  it('honours an attempts cap of 1 — no retry at all', async () => {
    fetchMock.mockResolvedValue(S503())

    await fetchWithRetry('https://x.test', {}, { ...OPTS, attempts: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('what must NOT be retried', () => {
  it('the SMS send and the Kroger chokepoint do not use fetchWithRetry', async () => {
    // Structural, not behavioural, because the reason is architectural:
    //
    //   telnyx.ts  — dispatchToTelnyx() POSTs a real text message, and its own
    //     comment notes a timeout is "genuinely ambiguous — Telnyx may or may
    //     not have accepted the message". Retrying that texts a guest twice.
    //     Telnyx does not deduplicate for us.
    //   kroger/client.ts — every call funnels through a rate limiter AND a
    //     circuit breaker that throws NonRetriableError with the comment
    //     "retrying is precisely the behaviour that amplifies the outage".
    //     Counting each attempt as a breaker failure trips the circuit N times
    //     faster than the threshold intends; not counting them blinds it.
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const root = join(__dirname, '..', '..')

    for (const file of ['lib/sms/telnyx.ts', 'lib/kroger/client.ts']) {
      const src = readFileSync(join(root, file), 'utf8')
      expect(
        /fetchWithRetry\s*\(/.test(src),
        `${file} must NOT retry in-process — see the comment in lib/http/retry.ts. ` +
        'If a duplicate of the call is genuinely harmless now, the fix is an ' +
        'idempotency key upstream, not a retry wrapper.',
      ).toBe(false)
    }
  })
})
