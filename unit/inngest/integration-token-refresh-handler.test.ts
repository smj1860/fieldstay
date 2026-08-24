import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  refreshHospitableTokenLocked: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/kroger-token', () => ({
  refreshKrogerTokenSingleFlight: vi.fn(),
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
import { refreshHospitableTokenLocked } from '@/lib/integrations/providers/hospitable-token'
import { refreshKrogerTokenSingleFlight } from '@/lib/integrations/providers/kroger-token'
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
// this batch. Since 2026-08-09 there is exactly ONE write per terminal
// failure: the mark-revoked UPDATE also claims the reconnect email, gated on
// `reconnect_email_sent_at IS NULL`. It returns a row when this run won the
// claim and nothing when a previous run already did.
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
    chain.is     = (...a: unknown[]) => record('is', a)

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
    ;(refreshHospitableTokenLocked as ReturnType<typeof vi.fn>).mockResolvedValue('new_access_token')
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(integrationTokenRefreshHandler, {
      event:  refreshEvent({ provider_id: 'hospitable', external_user_id: 'ext_1' }),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(refreshHospitableTokenLocked).toHaveBeenCalledWith('user_1', 'ext_1')
    expect(refreshKrogerTokenSingleFlight).not.toHaveBeenCalled()
    expect(result).toEqual({ user_id: 'user_1', provider_id: 'hospitable', refreshed: true })
    expect(supabase.calls).toHaveLength(0)
  })

  it('refreshes a Kroger connection successfully', async () => {
    ;(refreshKrogerTokenSingleFlight as ReturnType<typeof vi.fn>).mockResolvedValue('new_kroger_token')
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(integrationTokenRefreshHandler, {
      event:  refreshEvent({ provider_id: 'kroger' }),
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(refreshKrogerTokenSingleFlight).toHaveBeenCalledWith('user_1')
    expect(result).toEqual({ user_id: 'user_1', provider_id: 'kroger', refreshed: true })
  })

  it('re-throws a non-terminal (network/5xx) failure for Inngest to retry, without touching the DB', async () => {
    ;(refreshHospitableTokenLocked as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network timeout'))
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
    ;(refreshKrogerTokenSingleFlight as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Kroger 401 unauthorized'))
    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null },  // claim won
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

    // ONE write. The revoke and the email claim are the same statement, gated
    // on reconnect_email_sent_at IS NULL — a dedup flag written after the
    // thing it deduplicates is not a dedup flag (see the source comment).
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0]).toMatchObject({
      status:                  'revoked',
      reconnect_email_sent_at: expect.any(String),
    })
    const isCalls = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'is')
    expect(isCalls[0].args).toEqual(['reconnect_email_sent_at', null])

    expect(getPmEmails).toHaveBeenCalledWith(supabase, 'org_1')
    expect(renderIntegrationErrorEmail).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'Kroger', reconnectUrl: 'https://app.fieldstay.test/settings/integrations' }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@example.test', subject: expect.stringContaining('Kroger') }),
      { idempotencyKey: 'integration-reconnect-kroger-user_1' },
    )
  })

  it('does not re-send the reconnect email when one was already sent for this connection (dedup)', async () => {
    ;(refreshHospitableTokenLocked as ReturnType<typeof vi.fn>).mockRejectedValue(new NonRetriableError('bad refresh token'))
    // The claim matches no row, because reconnect_email_sent_at is already
    // set. This is the case that used to repeat DAILY: the cron re-fires for
    // this connection every day, the refresh fails every day, and the old code
    // read a flag that the send step had failed to write — so the PM got the
    // same "action required" email every morning until that write happened to
    // land.
    const supabase = makeSupabase({
      integration_connections: [
        { data: null, error: null },  // claim lost
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
    expect(updates).toHaveLength(1)
  })

  it('skips the email (but still marks the connection revoked) when there is no org_id to resolve a PM from', async () => {
    ;(refreshKrogerTokenSingleFlight as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('400 bad request'))
    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null },  // claim won
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
    expect(updates).toHaveLength(1) // the combined revoke + claim
  })

  it('skips the email when no PM email can be resolved for the org', async () => {
    ;(refreshHospitableTokenLocked as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 invalid_grant'))
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null },  // claim won
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
    expect(updates).toHaveLength(1) // the combined revoke + claim
  })

  it('THROWS when the email send fails, rather than swallowing it', async () => {
    // This used to log and return. It could afford to, because tomorrow's cron
    // run would try again — which was also the bug: it tried again every day
    // forever, since the flag that would have stopped it was written by the
    // very step that failed.
    //
    // The claim is taken BEFORE the send now, so a swallowed failure would
    // mean the PM is never told at all. Throwing spends the function's
    // remaining retries on the send and, on exhaustion, reaches the
    // dead-letter handler. Note the error is a plain Error, NOT the
    // NonRetriableError the terminal path ends with — that distinction is the
    // retry.
    ;(refreshHospitableTokenLocked as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 invalid_grant'))
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: null, error: { message: 'send failed' } })
    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null },  // claim won
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const err = await invokeHandler(integrationTokenRefreshHandler, {
      event:  refreshEvent({ provider_id: 'hospitable', org_id: 'org_1' }),
      step:   makeStep(),
      logger: makeLogger(),
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetriableError)
    expect((err as Error).message).toMatch(/Reconnect email send failed/)
  })

  it('an unsupported provider is treated as a terminal failure and still runs the revoke/notify path', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        { data: { id: 'conn_1' }, error: null },  // claim won
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

    expect(refreshHospitableTokenLocked).not.toHaveBeenCalled()
    expect(refreshKrogerTokenSingleFlight).not.toHaveBeenCalled()
    const updates = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(updates[0].args[0]).toMatchObject({ status: 'revoked' })
  })
})
