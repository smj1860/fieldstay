import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
  getPmMembers:         vi.fn(async () => [{ userId: 'u1', email: 'pm@example.test' }]),
}))
vi.mock('@/lib/resend/client', () => ({
  FROM:   'FieldStay <test@example.test>',
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'e1' }, error: null })) } },
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>alert</html>'),
}))

import { notifyIntegrationError } from '@/lib/inngest/functions/notify-integration-error'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification, getPmMembers } from '@/lib/inngest/helpers'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function connectionErrorEvent(overrides: Partial<{ org_id: string; provider_id: string; reason: string }> = {}) {
  return {
    data: {
      org_id:      'org_1',
      provider_id: 'kroger',
      reason:      'Access token could not be refreshed',
      ...overrides,
    },
  }
}

describe('notifyIntegrationError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a bell notification with the friendly provider display name', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'kroger', reason: 'Refresh token revoked' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, emailed: 1, org_id: 'org_1', provider_id: 'kroger' })
    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'integration_connection_error',
      title:     'Kroger connection needs attention',
      subtitle:  'Refresh token revoked',
      href:      '/settings/integrations',
      severity:  'red',
      dedupeKey: expect.stringMatching(/^integration-error-org_1-kroger-\d{4}-\d{2}-\d{2}$/) as unknown as string,
    })
  })

  it('falls back to the raw provider_id as the display name for an unmapped provider', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'some_new_provider', reason: 'Connection lost' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, emailed: 1, org_id: 'org_1', provider_id: 'some_new_provider' })
    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ title: 'some_new_provider connection needs attention' }),
    )
  })

  it('recognizes every mapped provider display name', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const cases: [string, string][] = [
      ['ownerrez',   'OwnerRez'],
      ['kroger',     'Kroger'],
      ['hostaway',   'Hostaway'],
      ['hospitable', 'Hospitable'],
      ['ical',       'iCal'],
    ]

    for (const [providerId, displayName] of cases) {
      ;(createPmNotification as ReturnType<typeof vi.fn>).mockClear()

      await invokeHandler(notifyIntegrationError, {
        event: connectionErrorEvent({ provider_id: providerId }),
        step:  makeStep(),
      })

      expect(createPmNotification).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({ title: `${displayName} connection needs attention` }),
      )
    }
  })

  describe('dedupe-key date suffix', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T23:59:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('uses today\'s UTC date (YYYY-MM-DD) so a repeat error the same day dedupes', async () => {
      const supabase = {}
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(notifyIntegrationError, {
        event: connectionErrorEvent({ org_id: 'org_9', provider_id: 'hospitable' }),
        step:  makeStep(),
      })

      expect(createPmNotification).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({ dedupeKey: 'integration-error-org_9-hospitable-2026-07-22' }),
      )
    })
  })

  it('emails every PM recipient, not just the bell', async () => {
    // The bell alone is what let one org's Hospitable connection sit dead for
    // four days: a red badge only reaches a PM who opens FieldStay, and a PM
    // whose syncs have stopped has fewer reasons to open it, not more.
    const send = vi.mocked(resend.emails.send)
    vi.mocked(getPmMembers).mockResolvedValueOnce([
      { userId: 'u1', email: 'a@example.test' },
      { userId: 'u2', email: 'b@example.test' },
    ] as never)

    await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'hospitable' }),
      step:  makeStep(),
    })

    expect(send).toHaveBeenCalledTimes(2)
    const [payload] = send.mock.calls[0]!
    expect(payload.to).toBe('a@example.test')
    expect(payload.subject).toContain('Hospitable')
    expect(payload.subject).toContain('Action required')
  })

  it('passes an idempotencyKey on every send', async () => {
    // An Inngest step is replayed on ANY failure, including one AFTER the send
    // succeeded — without a key the PM is mailed twice about one dead
    // connection. unit/guardrails/inngest-email-idempotency.ts enforces the
    // presence of the argument; this pins that the key is actually distinct
    // per recipient rather than one key shared across the fan-out, which would
    // suppress every email after the first.
    const send = vi.mocked(resend.emails.send)
    vi.mocked(getPmMembers).mockResolvedValueOnce([
      { userId: 'u1', email: 'a@example.test' },
      { userId: 'u2', email: 'b@example.test' },
    ] as never)

    await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'hospitable' }),
      step:  makeStep(),
    })

    const keys = send.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size, 'both recipients share one key — the second send is suppressed').toBe(2)
    for (const k of keys) expect(k).toContain('hospitable')
  })

  it('caps the fan-out even if the recipient query returns more', async () => {
    // The slice is not redundant with the query limit: that limit is an
    // argument to getPmMembers, so a change to that helper would silently widen
    // an Inngest run's step count. This asserts the local ceiling holds on its
    // own.
    const send = vi.mocked(resend.emails.send)
    vi.mocked(getPmMembers).mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => ({ userId: `u${i}`, email: `p${i}@example.test` })) as never,
    )

    await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'hospitable' }),
      step:  makeStep(),
    })

    expect(send).toHaveBeenCalledTimes(10)
  })

})
