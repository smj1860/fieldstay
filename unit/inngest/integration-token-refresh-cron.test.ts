import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { integrationTokenRefreshCron } from '@/lib/inngest/functions/cron/integration-token-refresh'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Cron function — no meaningful `data` on the real event (only wall-clock
// date driven), so `event` is `{}`.

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
    chain.select = (...a: unknown[]) => record('select', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.lte    = (...a: unknown[]) => record('lte', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

// This cron only runs step.run (fetch) and step.sendEvent (fan-out) — no
// step.sleep — so the stub only needs those two.
function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => undefined),
  }
}

describe('integrationTokenRefreshCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches one proactive-refresh event per connection expiring within the window', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        {
          data: [
            { user_id: 'user_1', org_id: 'org_1', provider_id: 'hospitable', external_user_id: 'ext_1', expires_at: '2026-07-22T01:00:00.000Z' },
            { user_id: 'user_2', org_id: null, provider_id: 'kroger', external_user_id: null, expires_at: '2026-07-22T01:30:00.000Z' },
          ],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step   = makeStep()
    const result = await invokeHandler(integrationTokenRefreshCron, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith('dispatch-refresh-events', [
      {
        name: 'integration/token.proactive.refresh.requested',
        data: {
          user_id:          'user_1',
          org_id:           'org_1',
          provider_id:      'hospitable',
          external_user_id: 'ext_1',
        },
      },
      {
        name: 'integration/token.proactive.refresh.requested',
        data: {
          user_id:          'user_2',
          org_id:           null,
          provider_id:      'kroger',
          external_user_id: '',
        },
      },
    ])
  })

  it('is a no-op and does not dispatch when nothing is expiring within the window', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step   = makeStep()
    const result = await invokeHandler(integrationTokenRefreshCron, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('throws when the connections query itself errors', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: null, error: { message: 'db unavailable' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(integrationTokenRefreshCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('Token refresh cron: DB query failed: db unavailable')
  })

  describe('60-minute expiry window boundary', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('queries expires_at <= now + 60 minutes', async () => {
      const supabase = makeSupabase({
        integration_connections: [{ data: [], error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(integrationTokenRefreshCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const lteCall = supabase.calls.find(
        (c) => c.table === 'integration_connections' && c.method === 'lte' && c.args[0] === 'expires_at',
      )
      expect(lteCall?.args[1]).toBe('2026-07-22T01:00:00.000Z')
    })

    it('only queries the two providers with expiring access tokens (OwnerRez tokens never expire)', async () => {
      const supabase = makeSupabase({
        integration_connections: [{ data: [], error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(integrationTokenRefreshCron, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const inCall = supabase.calls.find(
        (c) => c.table === 'integration_connections' && c.method === 'in' && c.args[0] === 'provider_id',
      )
      expect(inCall?.args[1]).toEqual(['hospitable', 'kroger'])
    })
  })
})
