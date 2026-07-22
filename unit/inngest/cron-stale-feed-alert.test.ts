import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmMembers: vi.fn(async () => []),
}))

import { staleFeedAlert } from '@/lib/inngest/functions/cron/stale-feed-alert'
import { createServiceClient } from '@/lib/supabase/server'
import { getPmMembers } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

function makeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq     = () => chain
    chain.or     = () => chain
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: null, error: null }).then(resolve, reject)
    return chain
  })
  return { from }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

describe('staleFeedAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no stale iCal feeds', async () => {
    const supabase = makeSupabase({ ical_feeds: { data: [], error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(staleFeedAlert, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ alerted: 0 })
    expect(getPmMembers).not.toHaveBeenCalled()
  })

  it('groups stale feeds by org and fires one integration/connection.error event per org with a PM', async () => {
    const supabase = makeSupabase({
      ical_feeds: {
        data: [
          { id: 'feed_1', name: 'Airbnb', org_id: 'org_1', last_synced_at: null, properties: { name: 'Cabin A' } },
          { id: 'feed_2', name: 'VRBO', org_id: 'org_1', last_synced_at: '2026-07-20T00:00:00.000Z', properties: { name: 'Cabin B' } },
          { id: 'feed_3', name: 'Direct', org_id: 'org_2', last_synced_at: null, properties: { name: 'Lodge' } },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockImplementation(async (_client: unknown, orgId: string) => {
      if (orgId === 'org_1') return [{ userId: 'user_1', email: 'pm1@example.com', role: 'owner' }]
      return [] // org_2 has no PM — should be skipped, not crash
    })

    const step = makeStep()
    const result = await invokeHandler(staleFeedAlert, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ alerted: 1 })
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-stale-feed-org_1',
      expect.objectContaining({
        name: 'integration/connection.error',
        data: expect.objectContaining({
          user_id:     'user_1',
          org_id:      'org_1',
          provider_id: 'ical',
          reason:      "2 feeds haven't synced in 6+ hours",
        }),
      }),
    )
  })

  it('uses singular "feed" wording when only one feed is stale for an org', async () => {
    const supabase = makeSupabase({
      ical_feeds: {
        data: [
          { id: 'feed_1', name: 'Airbnb', org_id: 'org_1', last_synced_at: null, properties: { name: 'Cabin A' } },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'user_1', email: 'pm1@example.com', role: 'owner' },
    ])

    const step = makeStep()
    await invokeHandler(staleFeedAlert, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-stale-feed-org_1',
      expect.objectContaining({
        // NOTE: the source hardcodes "haven't" regardless of feedCount (only
        // "feed"/"feeds" is pluralized) — grammatically "1 feed haven't
        // synced" is off, but this asserts actual current behavior.
        data: expect.objectContaining({ reason: "1 feed haven't synced in 6+ hours" }),
      }),
    )
  })
})
