import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))

import { createServiceClient } from '@/lib/supabase/server'
import { frictionGrading, gradeFrictionForOrg } from '@/lib/inngest/functions/cron/friction-grading'
import { invokeHandler } from './test-helpers'

// Grading used to be one platform-wide RPC call with no per-tenant fan-out —
// the one exception to this codebase's disciplined per-org fan-out
// convention for a platform-wide Inngest scan. It is now a dispatcher (finds
// orgs with an ungraded row, fans out one event per org) plus a per-org
// handler that calls apply_friction_grading(p_org_id), same shape as
// billing-property-reconciliation.ts. The grading LOGIC is SQL and is
// verified against the live function, not mocked here — what these cover is
// the shell: dispatch, the per-org RPC call, and failing loudly rather than
// reporting a silent success.

function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'is', 'order', 'range']) chain[m] = () => chain
    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: [], error: null })
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, rpc: vi.fn() }
}

describe('frictionGrading (cron fan-out)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches one event per org carrying an ungraded row', async () => {
    const supabase = makeSupabase({
      pre_flight_friction: [{ data: [{ org_id: 'org_1' }, { org_id: 'org_2' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(frictionGrading, { event: {}, step, logger })

    expect(result).toEqual({ dispatched: 2 })
    // sendEventsChunked names each chunk's step `${prefix}-${i}` — `-0` here
    // since both orgs fit in one chunk.
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-friction-grading-0', [
      { name: 'friction/grading.requested', data: { org_id: 'org_1' } },
      { name: 'friction/grading.requested', data: { org_id: 'org_2' } },
    ])
  })

  it('dispatches nothing when no org has an ungraded row', async () => {
    const supabase = makeSupabase({ pre_flight_friction: [{ data: [], error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
    const logger = { info: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(frictionGrading, { event: {}, step, logger })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('gradeFrictionForOrg — per-org handler', () => {
  beforeEach(() => vi.clearAllMocks())

  function run(orgId: string, rpc: ReturnType<typeof vi.fn>) {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({ rpc })
    const step = { run: vi.fn((_n: string, cb: () => unknown) => cb()) }
    const logger = { info: vi.fn(), error: vi.fn() }
    return invokeHandler(gradeFrictionForOrg, { event: { data: { org_id: orgId } }, step, logger })
  }

  it('calls apply_friction_grading scoped to the one org and reports the count', async () => {
    const rpc = vi.fn(async () => ({ data: { graded: 7 }, error: null }))
    const result = await run('org_1', rpc)

    expect(result).toEqual({ org_id: 'org_1', graded: 7 })
    expect(rpc).toHaveBeenCalledWith('apply_friction_grading', { p_org_id: 'org_1' })
  })

  it('throws on an RPC error rather than reporting a silent success', async () => {
    // A swallowed error here would log "graded 0" forever while the loop was
    // dead — the calibration view would just look like there is no data yet.
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied' } }))
    await expect(run('org_1', rpc)).rejects.toThrow(
      /apply_friction_grading failed for org org_1: permission denied/,
    )
  })

  it('is naturally idempotent under a per-org concurrency key', () => {
    // Same guarantee as reconcilePropertyCountForOrg: a retried dispatcher
    // step.sendEvent() can re-queue a second event for the same org, and
    // this is what stops two concurrent invocations from doing redundant
    // work, alongside a global cap that bounds the daily burst.
    const concurrency = (gradeFrictionForOrg as unknown as {
      opts: { concurrency: Array<{ limit: number; key?: string }> }
    }).opts.concurrency

    expect(concurrency).toContainEqual({ limit: 1, key: 'event.data.org_id' })
    expect(concurrency).toContainEqual({ limit: 10 })
  })
})
