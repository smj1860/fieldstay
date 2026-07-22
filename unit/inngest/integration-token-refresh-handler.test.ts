import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  refreshHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/kroger-token', () => ({
  refreshKrogerToken: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/integration-error', () => ({
  renderIntegrationErrorEmail: vi.fn(async () => '<html>reconnect</html>'),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails: vi.fn(async () => ['pm@example.test']),
}))

import { integrationTokenRefreshHandler } from '@/lib/inngest/functions/cron/integration-token-refresh-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { refreshHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { refreshKrogerToken } from '@/lib/integrations/providers/kroger-token'
import { resend } from '@/lib/resend/client'
import { renderIntegrationErrorEmail } from '@/lib/resend/emails/integration-error'
import { getPmEmails } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// logger.warn is used by the source but is not part of test-helpers'
// HandlerContext type — declaring it on a named function (rather than an
// inline object literal at the call site) sidesteps TS's excess-property
// check while still providing a real .warn the source can call at runtime.
// Mirrors work-order-vendor-assigned.test.ts's makeLogger().
function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

// Queue-based `.from(table)` mock, same convention as the other tests in
// this batch. `integration_connections` is queried up to twice per terminal
// failure (mark-revoked, then the reconnect-email-sent stamp), so order
// matters.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.select = (...a: unknown[]) => record('select', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function refreshEvent(overrides: Partial<{
  user_id: string
  org_id: string | null
  provider_id: string
  external_user_id: string
}> = {}) {
  return {
    data: {
      user_id:          'user_1',
      org_id:           'org_1',
      provider_id:      'hospitable',
      external_user_id: 'ext_1',
      ...overrides,
    },
  }
}

describe('integrationTokenRefreshHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
  })

  it('refreshes a Hospitable connection successfully and makes no DB writes', async () => {
    ;(refreshHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('new_access_token')
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(integrationTokenRefreshHandler, {
      event:  refreshEvent({ provider_id: 'hospitable', external_user_id: 'ext_1' }),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(refreshHospitableToken).toHaveBeenCalledWith('user_1', 'ext_1')
    expect(refreshKrogerToken).not.toHaveBeenCalled()
    expect(result).toEqual({ user_id: 'user_1', provider_id: 'hospitable', refreshed: true })
    expect(supabase.calls).toHaveLength(0)
  })

  it('refreshes a Kroger connection successfully', async () => {
    ;(refreshKrogerToken as ReturnType<typeof vi.fn>).mockResolvedValue('new_kroger_token')
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(integrationTokenRefreshHandler, {
      event:  refreshEvent({ provider_id: 'kroger' }),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(refreshKrogerToken).toHaveBeenCalledWith('user_1')
    expect(result).toEqual({ user_id: 'user_1', provider_id: 'kroger', refreshed: true })
  })

  it('re-throws a non-terminal (network/5xx) failure for Inngest to retry, without touching the DB', async () => {
    ;(refreshHospitableToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network timeout'))
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'hospitable' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('network timeout')

    expect(supabase.calls).toHaveLength(0)
  })

  it('marks the connection revoked and sends one reconnect email on a terminal (401) failure', async () => {
    ;(refreshKrogerToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Kroger 401 unauthorized'))
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: null }, error: null }, // mark-revoked
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'kroger', org_id: 'org_1' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[0].args[0]).toMatchObject({ status: 'revoked' })
    expect(updates[1].args[0]).toMatchObject({ reconnect_email_sent_at: expect.any(String) })

    expect(getPmEmails).toHaveBeenCalledWith(supabase, 'org_1')
    expect(renderIntegrationErrorEmail).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'Kroger', reconnectUrl: 'https://app.fieldstay.test/settings/integrations' }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@example.test', subject: expect.stringContaining('Kroger') }),
    )
  })

  it('does not re-send the reconnect email when one was already sent for this connection (dedup)', async () => {
    ;(refreshHospitableToken as ReturnType<typeof vi.fn>).mockRejectedValue(new NonRetriableError('bad refresh token'))
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: '2026-07-20T00:00:00.000Z' }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'hospitable', org_id: 'org_1' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    expect(resend.emails.send).not.toHaveBeenCalled()
    // Only the mark-revoked update ran — no second write to re-stamp
    // reconnect_email_sent_at once it's already set.
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(1)
  })

  it('skips the email (but still marks the connection revoked) when there is no org_id to resolve a PM from', async () => {
    ;(refreshKrogerToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('400 bad request'))
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: null }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'kroger', org_id: null }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    expect(getPmEmails).not.toHaveBeenCalled()
    expect(resend.emails.send).not.toHaveBeenCalled()
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(1) // mark-revoked only
  })

  it('skips the email when no PM email can be resolved for the org', async () => {
    ;(refreshHospitableToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 invalid_grant'))
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: null }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'hospitable', org_id: 'org_1' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    expect(resend.emails.send).not.toHaveBeenCalled()
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(1) // mark-revoked only — no reconnect_email_sent_at stamp
  })

  it('does not stamp reconnect_email_sent_at when the email send itself fails (non-fatal)', async () => {
    ;(refreshHospitableToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 invalid_grant'))
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: null, error: { message: 'send failed' } })
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: null }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'hospitable', org_id: 'org_1' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(1) // only mark-revoked — send failure does not get stamped as sent
  })

  it('an unsupported provider is treated as a terminal failure and still runs the revoke/notify path', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        { data: { reconnect_email_sent_at: null }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshHandler, {
        event:  refreshEvent({ provider_id: 'unknown_provider', org_id: 'org_1' }),
        step:   makeStep(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(NonRetriableError)

    expect(refreshHospitableToken).not.toHaveBeenCalled()
    expect(refreshKrogerToken).not.toHaveBeenCalled()
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates[0].args[0]).toMatchObject({ status: 'revoked' })
  })
})
