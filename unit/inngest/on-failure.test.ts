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

import { onFunctionFailure, CRITICAL_FUNCTION_IDS } from '@/lib/inngest/functions/on-failure'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// The dead-letter handler has no per-step DB work — a bare-bones step stub
// that just executes the callback is enough to exercise its real logic.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function failureEvent(functionId: string) {
  return {
    data: {
      function_id: functionId,
      run_id:      'run_1',
      error:       { name: 'Error', message: 'boom' },
    },
  }
}

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
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('turnover-completed') }),
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
