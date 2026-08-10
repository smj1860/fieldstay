// lib/http/retry.ts
// ============================================================================
// In-process retry with backoff for IDEMPOTENT outbound GETs.
//
// Without it, a single dropped packet or one brief 503 from a provider throws
// straight out to Inngest's step retry — which re-runs the ENTIRE step,
// including any database work already done inside it, on a schedule tuned to
// nothing in particular. A 200ms blip costs a whole step replay.
//
// ── This is deliberately NOT applied to every outbound call ─────────────────
//
// Scalability audit P1-13 proposed adding it to all four integration clients
// (Kroger, Telnyx, Mapbox, Tomorrow.io). Two of those would be actively worse
// for it, and in both cases the file being "fixed" already explains why:
//
//   lib/kroger/client.ts — every Kroger call funnels through a chokepoint that
//     already has a RATE LIMITER and a CIRCUIT BREAKER, and throws
//     NonRetriableError when the breaker is open with the comment "retrying is
//     precisely the behaviour that amplifies the outage". Retrying inside that
//     guard is incoherent whichever way you wire it: count each attempt as a
//     breaker failure and one logical call trips the circuit N times faster
//     than the threshold intends; don't count them and the breaker is blind to
//     the traffic it exists to measure.
//
//   lib/sms/telnyx.ts — dispatchToTelnyx() is a POST that sends a real text
//     message, and its own comment notes a timeout is "genuinely ambiguous —
//     Telnyx may or may not have accepted the message". Retrying an ambiguous
//     send texts a guest twice: a TCPA-relevant, money-costing, user-visible
//     duplicate. Telnyx does not deduplicate these for us.
//
// So this is for reads that are safe to repeat and cheap to lose: Mapbox
// geocoding and Tomorrow.io weather. Adding a caller means answering "is a
// duplicate of this request harmless?" first — if the answer is no, the
// correct fix is upstream (an idempotency key, a claim row), not a retry.
// ============================================================================

import { isTimeoutError } from '@/lib/http/timeout'

export interface RetryOptions {
  /** Total attempts INCLUDING the first. 3 = one call plus two retries. */
  attempts?: number
  /** Per-attempt timeout. The overall budget is roughly attempts x this. */
  timeoutMs: number
  /** Base backoff; attempt N waits base * 2^(N-1), plus jitter. */
  baseDelayMs?: number
  /** For log lines — the service being called. */
  label: string
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 200

/** Jitter, so N callers retrying the same blip do not resynchronise on it. */
function backoffMs(attempt: number, base: number): number {
  // eslint-disable-next-line no-restricted-properties -- retry jitter to desynchronise concurrent callers, not id/token generation
  const jitter = Math.random() * base // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
  return base * 2 ** (attempt - 1) + jitter
}

/**
 * Retries only what is worth retrying.
 *
 * A 5xx or a 429 is the provider saying "not now"; a timeout is us giving up
 * waiting. Those are transient and a second attempt is reasonable. A 4xx is
 * OUR request being wrong — a bad token, a malformed query — and will never
 * clear by waiting, so it is returned to the caller immediately rather than
 * spending the budget confirming it.
 *
 * Returns the final Response even when it is still a failure, so the caller's
 * existing status handling is unchanged. Only a thrown transport error
 * propagates as a throw.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS
  const base     = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(input, {
        ...init,
        // Per ATTEMPT, not per call: a signal shared across attempts would be
        // already-aborted on the second one, turning the retry into an
        // instant failure that looks like the provider answering.
        signal: AbortSignal.timeout(opts.timeoutMs),
      })

      // Worth another go, but only if we have one left.
      if ((res.status >= 500 || res.status === 429) && attempt < attempts) {
        await sleep(backoffMs(attempt, base))
        continue
      }

      return res
    } catch (err) {
      lastError = err

      // A transport error that is NOT a timeout (DNS, TLS, connection refused)
      // is retried on the same grounds — it is a network blip, not a bad
      // request — but the last attempt always rethrows so the caller sees the
      // real error rather than a synthesised one.
      if (attempt === attempts) throw err
      await sleep(backoffMs(attempt, base))
    }
  }

  // Unreachable: the loop either returns, or throws on its final attempt.
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.label}: retries exhausted`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { isTimeoutError }
