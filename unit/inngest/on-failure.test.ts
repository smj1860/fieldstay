import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html></html>'),
}))

import * as Sentry from '@sentry/nextjs'

import { onFunctionFailure, CRITICAL_FUNCTION_IDS } from '@/lib/inngest/functions/on-failure'
import { reconnectRequired } from '@/lib/inngest/reconnect-required'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// The dead-letter handler has no per-step DB work — a bare-bones step stub
// that just executes the callback is enough to exercise its real logic.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function failureEvent(functionId: string, message = 'boom') {
  return {
    data: {
      function_id: functionId,
      run_id:      'run_1',
      // `name: 'Error'` is not laziness — it is what Inngest actually
      // serializes. The production event for a thrown NonRetriableError
      // carried exactly this, which is why the reconnect marker has to travel
      // in the message. See lib/inngest/reconnect-required.ts.
      error:       { name: 'Error', message },
    },
  }
}

function run(functionId: string, message?: string) {
  return invokeHandler(onFunctionFailure, {
    event:  failureEvent(functionId, message),
    step:   makeStep(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
}

const captured = () => (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls[0]

describe('CRITICAL_FUNCTION_IDS', () => {
  it('covers the three functions that post to the owner_transactions ledger', () => {
    expect(CRITICAL_FUNCTION_IDS.has('turnover-completed')).toBe(true)
    expect(CRITICAL_FUNCTION_IDS.has('work-order-completed')).toBe(true)
    expect(CRITICAL_FUNCTION_IDS.has('purchase-order-approved')).toBe(true)
  })
})

describe('onFunctionFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a founder alert when a critical function exhausts retries', async () => {
    const result = await invokeHandler(onFunctionFailure, {
      event:  failureEvent('turnover-completed'),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    // Keyed on run_id — this handler is itself retried, and a duplicate
    // "critical job failed" alert arrives at the exact moment the founder is
    // already trying to work out what broke.
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('turnover-completed') }),
      { idempotencyKey: 'critical-job-failed-run_1' },
    )
    expect(result).toEqual({ function_id: 'turnover-completed', alerted: true })
  })

  it('does not send an alert for a non-critical function', async () => {
    const result = await invokeHandler(onFunctionFailure, {
      event:  failureEvent('some-non-critical-function'),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ function_id: 'some-non-critical-function', alerted: false })
  })
})

// ============================================================================
// Sentry, 2026-08-19, twice: `[Inngest] fieldstay-ownerrez-connection-sync
// exhausted all retries: OwnerRez authorization expired — reconnect your
// account to resume syncing`.
//
// Filed as an error, and — since ownerrez-connection-sync is in
// CRITICAL_FUNCTION_IDS — it also sent the founder a "🚨 Critical job failed"
// email. For one customer's OAuth grant lapsing: nothing failed on our side,
// no retry was exhausted (a NonRetriableError opts out of the retry policy
// entirely), and the only person who can resolve it is the PM, who the sync
// that raised it had already notified.
// ============================================================================
describe('onFunctionFailure — reconnect-required failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const reconnectMessage = () =>
    reconnectRequired('OwnerRez authorization expired — reconnect your account to resume syncing').message

  it('does not page the founder, even for a critical function', async () => {
    const result = await run('ownerrez-connection-sync', reconnectMessage())

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ function_id: 'ownerrez-connection-sync', alerted: false })
  })

  it('reports it as a warning, not an error', async () => {
    await run('ownerrez-connection-sync', reconnectMessage())

    expect(captured()[1]).toMatchObject({
      level: 'warning',
      tags:  { failure_kind: 'reconnect_required' },
    })
  })

  it('does not claim retries were exhausted, and hides the marker', async () => {
    await run('ownerrez-connection-sync', reconnectMessage())

    const message = (captured()[0] as Error).message
    expect(message).not.toContain('exhausted all retries')
    // The marker is machine-readable plumbing — it must never reach a title
    // someone reads.
    expect(message).not.toContain('[reconnect-required]')
    expect(message).toContain('reconnect required')
    expect(message).toContain('OwnerRez authorization expired')
  })

  it('still reports a genuine retry exhaustion as an error and pages', async () => {
    // The negative half: this classification must not swallow real failures.
    await run('ownerrez-connection-sync', 'ECONNRESET talking to OwnerRez')

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(captured()[1]).toMatchObject({
      level: 'error',
      tags:  { failure_kind: 'retries_exhausted' },
    })
    expect((captured()[0] as Error).message).toContain('exhausted all retries')
  })

  it('is not satisfied by prose that merely mentions reconnecting', async () => {
    // The check keys on the marker, not on wording — otherwise any provider
    // error string containing the word would silently stop paging.
    await run('turnover-completed', 'reconnect required to continue')

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(captured()[1]).toMatchObject({ level: 'error' })
  })
})
