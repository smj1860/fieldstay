import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { systemWatchdog, WATCHED_JOBS } from '@/lib/inngest/functions/cron/watchdog'
import { jobRunRecorder }               from '@/lib/inngest/functions/cron/job-run-recorder'
import { createServiceClient }          from '@/lib/supabase/server'
import { reportError }                  from '@/lib/observability/report-error'
import { invokeHandler }                from './test-helpers'

// ============================================================================
// Detecting ABSENCE.
//
// Sentry catches errors; every guardrail reads code; db-invariants inspects
// schema. None can notice that something simply STOPPED — a cron that no
// longer fires, an integration whose webhooks are being rejected. Absence
// throws nothing, so it reaches no error tracker.
//
// Two live incidents in one week were found only because a person looked: a
// geocoding backfill that had never run (nothing sent its only trigger), and a
// rotated Hospitable webhook secret that left a real customer's reservations
// undelivered for hours.
//
// The tests that matter here are the ones proving this FIRES. A watchdog that
// silently never alerts is indistinguishable from a healthy system, which is
// the precise failure it exists to prevent.
// ============================================================================

const NOW = new Date('2026-08-15T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

function runAllStep() {
  return { run: vi.fn((_n: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}
function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

interface Queued { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: Queued, writes: { table: string; rows: unknown }[] = []) {
  const counters: Record<string, number> = {}
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.gte = () => chain
    chain.order = vi.fn(() => chain)
    chain.range = vi.fn(() => chain)
    chain.upsert = vi.fn((rows: unknown) => { writes.push({ table, rows }); return Promise.resolve({ error: null }) })
    const next = () => {
      const i = counters[table] ?? 0
      counters[table] = i + 1
      return Promise.resolve(queued[table]?.[i] ?? { data: [], error: null })
    }
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej)
    return chain
  })
  return { from }
}

/** Every watched job reporting a run 1h ago — the healthy baseline. */
const allJobsHealthy = () =>
  WATCHED_JOBS.map((j) => ({ function_id: j.id, started_at: hoursAgo(1) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('systemWatchdog — silent jobs', () => {
  it('reports a job that has stopped running', async () => {
    // The core case: hourly job, nothing recorded inside its budget.
    const runs = allJobsHealthy().filter((r) => r.function_id !== 'ownerrez-incremental-sync')
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ system_job_runs: [{ data: runs, error: null }], integration_connections: [{ data: [], error: null }] }),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    expect(res.silentJobs).toBe(1)
    expect(reportError).toHaveBeenCalled()
    const msg = String((reportError as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(msg).toContain('ownerrez-incremental-sync')
  })

  it('does NOT report a daily job that ran 20 hours ago', async () => {
    // Budgets are ~2x the period on purpose: one missed or slow run must not
    // page anyone, or the alert gets muted and becomes worse than nothing.
    const runs = allJobsHealthy().map((r) =>
      r.function_id === 'cron-daily-wrapup' ? { ...r, started_at: hoursAgo(20) } : r)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ system_job_runs: [{ data: runs, error: null }], integration_connections: [{ data: [], error: null }] }),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    expect(res.silentJobs).toBe(0)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('reports a job with NO recorded run at all — the never-ran case', async () => {
    // The geocoding backfill shape: not "ran and stopped" but "never ran",
    // which a last-run-timestamp check misses if it only inspects rows present.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ system_job_runs: [{ data: [], error: null }], integration_connections: [{ data: [], error: null }] }),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    expect(res.silentJobs).toBe(WATCHED_JOBS.length)
  })
})

describe('systemWatchdog — quiet integrations', () => {
  const conn = (over: Record<string, unknown> = {}) => ({
    id: 'c1', provider_id: 'hospitable', org_id: 'org1',
    connected_at: hoursAgo(500), last_used_at: hoursAgo(1), updated_at: hoursAgo(1),
    ...over,
  })

  it('reports an active connection that has gone quiet — the webhook-secret incident', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({
        system_job_runs:         [{ data: allJobsHealthy(), error: null }],
        integration_connections: [{ data: [conn({ last_used_at: hoursAgo(72), updated_at: hoursAgo(72) })], error: null }],
      }),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { quietIntegrations: number }

    expect(res.quietIntegrations).toBe(1)
    const msg = String((reportError as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(msg).toContain('hospitable')
  })

  it('does not report a recently used connection', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({
        system_job_runs:         [{ data: allJobsHealthy(), error: null }],
        integration_connections: [{ data: [conn()], error: null }],
      }),
    )
    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { quietIntegrations: number }
    expect(res.quietIntegrations).toBe(0)
  })

  it('gives a brand-new connection a grace period', async () => {
    // Without this the alert fires on every new customer — the fastest way to
    // teach an operator to ignore it. A connection made an hour ago has
    // legitimately not been touched by a daily cron yet.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({
        system_job_runs:         [{ data: allJobsHealthy(), error: null }],
        integration_connections: [{ data: [conn({ connected_at: hoursAgo(1), last_used_at: null, updated_at: null })], error: null }],
      }),
    )
    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { quietIntegrations: number }
    expect(res.quietIntegrations).toBe(0)
    expect(reportError).not.toHaveBeenCalled()
  })
})

describe('jobRunRecorder', () => {
  it('REFUSES to record its own completion — otherwise it recurses forever', async () => {
    // This function is an Inngest function, so its own completion emits another
    // inngest/function.finished. Without the guard it re-triggers itself with
    // no bound. The single most important assertion in this file.
    const writes: { table: string; rows: unknown }[] = []
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({}, writes))

    const res = await invokeHandler(jobRunRecorder, {
      event: { data: { function_id: 'fieldstay-job-run-recorder', run_id: 'r1' } },
      step: runAllStep(), logger: makeLogger(),
    }) as { skipped: boolean; reason: string }

    expect(res).toEqual({ skipped: true, reason: 'self' })
    expect(writes).toHaveLength(0)
  })

  it('records another function under its BARE id, matching the watchdog registry', async () => {
    // Inngest reports `fieldstay-<id>`; WATCHED_JOBS is written in bare ids. If
    // these disagree the watchdog reports every job as silent forever.
    const writes: { table: string; rows: unknown }[] = []
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({}, writes))

    await invokeHandler(jobRunRecorder, {
      event: { data: { function_id: 'fieldstay-cron-daily-wrapup', run_id: 'r2' } },
      step: runAllStep(), logger: makeLogger(),
    })

    const row = writes[0]!.rows as { function_id: string; status: string }
    expect(row.function_id).toBe('cron-daily-wrapup')
    expect(row.status).toBe('completed')
    expect(WATCHED_JOBS.some((j) => j.id === row.function_id)).toBe(true)
  })

  it('records a failed run as failed, with the error message', async () => {
    const writes: { table: string; rows: unknown }[] = []
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({}, writes))

    await invokeHandler(jobRunRecorder, {
      event: { data: { function_id: 'fieldstay-cron-asset-health', run_id: 'r3', error: { message: 'boom' } } },
      step: runAllStep(), logger: makeLogger(),
    })

    const row = writes[0]!.rows as { status: string; error_message: string }
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('boom')
  })
})
