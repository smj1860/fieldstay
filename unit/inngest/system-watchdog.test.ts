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

interface SupaOpts {
  /** Oldest row in system_job_runs — the watchdog's proxy for "recording started". */
  oldestStartedAt?: string | null
  /** Total rows in system_job_runs, for the empty-ledger check. */
  jobRunCount?: number
}

function makeSupabase(
  queued: Queued,
  writes: { table: string; rows: unknown }[] = [],
  opts: SupaOpts = {},
) {
  const counters: Record<string, number> = {}
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let head = false
    chain.select = (_sel?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return chain }
    chain.eq = () => chain
    chain.gte = () => chain
    chain.order = vi.fn(() => chain)
    chain.range = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve({
      data: opts.oldestStartedAt ? { started_at: opts.oldestStartedAt } : null,
      error: null,
    }))
    chain.upsert = vi.fn((rows: unknown) => { writes.push({ table, rows }); return Promise.resolve({ error: null }) })
    const next = () => {
      if (head) return Promise.resolve({ count: opts.jobRunCount ?? 1, data: null, error: null })
      const i = counters[table] ?? 0
      counters[table] = i + 1
      return Promise.resolve(queued[table]?.[i] ?? { data: [], error: null })
    }
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej)
    return chain
  })
  return { from }
}

/** Recording has been live for ages — the steady state the old tests assumed. */
const RECORDING_MATURE = { oldestStartedAt: hoursAgo(200), jobRunCount: 50 }

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
      makeSupabase({ system_job_runs: [{ data: runs, error: null }], integration_connections: [{ data: [], error: null }] }, [], RECORDING_MATURE),
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
      makeSupabase({ system_job_runs: [{ data: runs, error: null }], integration_connections: [{ data: [], error: null }] }, [], RECORDING_MATURE),
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
      makeSupabase({ system_job_runs: [{ data: [], error: null }], integration_connections: [{ data: [], error: null }] }, [], RECORDING_MATURE),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    expect(res.silentJobs).toBe(WATCHED_JOBS.length)
  })
})

describe('systemWatchdog — cold start', () => {
  // The defect this closes, caught by reasoning about the first deploy rather
  // than by a test failing. system_job_runs starts empty, and "no recorded run"
  // is the same observation as "never ran". Without a guard the first run
  // reports all 10 watched jobs, and the 7 DAILY ones keep reporting every hour
  // until each fires — up to a day of alerts naming healthy crons. That is
  // precisely how an operator learns to ignore the channel, which would have
  // made the whole watchdog worse than not shipping it.

  it('stays silent about jobs never recorded when recording only just began', async () => {
    // Recording live for 2h. Every daily job (30h budget) is unobservable —
    // it simply has not been due yet.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: [], error: null }], integration_connections: [{ data: [], error: null }] },
        [],
        { oldestStartedAt: hoursAgo(2), jobRunCount: 5 },
      ),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    // Nothing: even the 3h-budget jobs are inside the 2h recording window.
    expect(res.silentJobs).toBe(0)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('starts reporting a never-recorded job once recording outlives its budget', async () => {
    // 5h of recording: the three 3h-budget jobs are now genuinely overdue,
    // while the seven daily ones remain unobservable. The guard must be
    // PER-JOB, not a global mute — a blanket warm-up would hide a real outage
    // in a frequent job for a full day.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: [], error: null }], integration_connections: [{ data: [], error: null }] },
        [],
        { oldestStartedAt: hoursAgo(5), jobRunCount: 20 },
      ),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    const shortBudget = WATCHED_JOBS.filter((j) => j.maxSilentHours < 5).length
    expect(shortBudget).toBeGreaterThan(0)
    expect(res.silentJobs).toBe(shortBudget)
  })

  it('a job that recorded and then STOPPED is reported regardless of recording age', async () => {
    // The guard must not become a way for a real outage to hide. This job has
    // a recorded run, so the cold-start path never applies to it.
    const runs = [{ function_id: 'ownerrez-incremental-sync', started_at: hoursAgo(10) }]
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: runs, error: null }], integration_connections: [{ data: [], error: null }] },
        [],
        { oldestStartedAt: hoursAgo(10), jobRunCount: 1 },
      ),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number }

    const msg = String((reportError as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(msg).toContain('ownerrez-incremental-sync')
    expect(res.silentJobs).toBeGreaterThanOrEqual(1)
  })

  it('reports an ENTIRELY empty ledger as one finding, not ten', async () => {
    // Expected exactly once, on the very first run before this watchdog's own
    // completion is recorded. After that an empty table means the recorder is
    // dead — worth knowing precisely because every other check depends on it.
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: [], error: null }], integration_connections: [{ data: [], error: null }] },
        [],
        { oldestStartedAt: null, jobRunCount: 0 },
      ),
    )

    const res = await invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as { silentJobs: number; noRunsRecorded: boolean }

    expect(res.noRunsRecorded).toBe(true)
    expect(res.silentJobs).toBe(0)
    expect(reportError).toHaveBeenCalledTimes(1)
    expect(String((reportError as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('empty')
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
      }, [], RECORDING_MATURE),
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
      }, [], RECORDING_MATURE),
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
      }, [], RECORDING_MATURE),
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
    // 'succeeded' is one of the three values system_job_runs_status_check
    // permits. This assertion is the only thing in the suite pinning it —
    // the mocked client happily accepted the wrong literal.
    expect(row.status).toBe('succeeded')
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

describe('systemWatchdog — slow jobs', () => {
  const TARGET = 'ownerrez-incremental-sync'

  /**
   * `count` healthy runs of TARGET at `normalMs`, plus every other watched job
   * once so nothing reports silent and muddies the assertion.
   */
  function runsWithDurations(durations: number[]) {
    const others = WATCHED_JOBS
      .filter((j) => j.id !== TARGET)
      .map((j) => ({ function_id: j.id, started_at: hoursAgo(1), duration_ms: 1_000 }))

    const target = durations.map((ms, i) => ({
      function_id: TARGET,
      started_at:  hoursAgo(durations.length - i),
      duration_ms: ms,
    }))

    return [...others, ...target]
  }

  function run(rows: unknown[]) {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: rows, error: null }], integration_connections: [{ data: [], error: null }] },
        [], RECORDING_MATURE,
      ),
    )
    return invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as Promise<{ slowJobs: number; silentJobs: number }>
  }

  it('reports a job whose latest run is a step change against its own median', async () => {
    // The actionable case: steady for hours, then one run takes minutes. That
    // is the shape of a job about to start timing out or overlapping its own
    // next tick.
    // TWO slow runs, not one — see the single-spike test below for why.
    const res = await run(runsWithDurations([4_000, 4_200, 3_900, 4_100, 400_000, 400_000]))

    expect(res.slowJobs).toBe(1)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('slow') }),
      expect.objectContaining({ site: 'inngest.system-watchdog.slow-jobs' }),
    )
  })

  it('does NOT report a single spike — one slow run is not a slow job', async () => {
    // This exact fixture used to fire, and that was the 2026-08-26 false alarm
    // in miniature: ownerrez-incremental-sync reported at "97s vs 9s median"
    // while every run that week succeeded, one booking row had changed in
    // fourteen hours, and two to four UNRELATED jobs were slow in the same
    // hours — cron-metrics-snapshot among them, which calls no external API.
    // Against a small median the 60s floor turns ordinary platform jitter into
    // a page, so a breach has to repeat before it counts.
    const res = await run(runsWithDurations([4_000, 4_200, 3_900, 4_100, 4_050, 400_000]))
    expect(res.slowJobs).toBe(0)
  })

  it('reports on the MULTIPLE, not just the absolute floor', async () => {
    // The step-change case above is caught by the 60s floor alone. This one is
    // above the floor throughout, so only the 3x-median rule can catch it —
    // which is what makes the rule self-calibrating rather than a disguised
    // fixed threshold.
    const res = await run(runsWithDurations([100_000, 100_000, 100_000, 100_000, 400_000, 400_000]))
    expect(res.slowJobs).toBe(1)
  })

  it('stays quiet for a job running at its normal speed', async () => {
    const res = await run(runsWithDurations([4_000, 4_200, 3_900, 4_100, 4_050, 4_300]))
    expect(res.slowJobs).toBe(0)
  })

  it('does NOT report a fast job that tripled — the floor', async () => {
    // 20ms to 60ms is a tripling and is noise. Without a floor every trivial
    // job would alarm on ordinary jitter, and an alarm that fires constantly
    // is one an operator mutes.
    const res = await run(runsWithDurations([20, 20, 20, 20, 20, 5_000]))
    expect(res.slowJobs).toBe(0)
  })

  it('does NOT judge a job with too little history', async () => {
    // A median of two samples is not a norm. Daily crons simply will not have
    // enough runs inside the 31h window — which is correct, not a gap: their
    // silence is already covered.
    // Three samples, not two: with exactly two the median sits between them and
    // the latest can never reach 3x it, so a two-sample fixture would pass no
    // matter what SLOW_MIN_SAMPLES was — asserting nothing. These three WOULD
    // be flagged if the minimum were lowered.
    const res = await run(runsWithDurations([4_000, 4_000, 400_000]))
    expect(res.slowJobs).toBe(0)
  })

  it('ignores rows with a null duration rather than treating them as zero', async () => {
    // Every row written before the recorder learned to compute duration has
    // duration_ms null. Counting those as 0ms would drag every median to zero
    // and make the next normal run look like an infinite slowdown — i.e. the
    // whole fleet alarms the moment this ships.
    // Sized so the bug is visible: 5 real samples (enough to judge) plus 8
    // null ones. Counted as zero, the nulls become the MAJORITY and drag the
    // median to 0 — so the threshold collapses to the floor and a perfectly
    // normal 100s run is reported as a slowdown. Left out, the median is the
    // real 100s and nothing fires.
    const real = runsWithDurations([100_000, 100_000, 100_000, 100_000, 100_000])
    const nulls = Array.from({ length: 8 }, (_, i) => ({
      function_id: TARGET, started_at: hoursAgo(20 + i), duration_ms: null,
    }))

    const res = await run([...real, ...nulls])
    expect(res.slowJobs).toBe(0)
  })

  it('does not count time a run spent QUEUED as time it spent working', async () => {
    // system_job_runs.started_at is when Inngest CREATED the run, not when it
    // began executing — job-run-recorder decodes it from the run id's ULID
    // because `inngest/function.finished` carries no timestamps. So for a
    // function declaring `concurrency: { limit: 1 }`, a run that waited for the
    // previous one books that entire wait as its own duration.
    //
    // No production alarm has been traced to this yet — the 2026-08-26
    // ownerrez-incremental-sync window was checked and had ZERO overlapping
    // runs, so its 97s was 97s of real execution. This covers the construction
    // defect rather than an observed incident: the moment a watched job does
    // overlap itself, duration_ms starts counting time it was not running.
    //
    // Timeline below: five 5s runs, then one genuinely slow 200s run, then a
    // run ENQUEUED 100s into that one — so it waits 100s and executes for 5s.
    // Raw duration 105s. Judged raw, the last three runs contain two breaches
    // of the 60s floor and this alarms. Judged on execution, only one does.
    const base = Date.now() - 6 * 3_600_000
    const at   = (ms: number) => new Date(base + ms).toISOString()

    const timeline = [
      { start: 0,         duration: 5_000   },
      { start: 600_000,   duration: 5_000   },
      { start: 1_200_000, duration: 5_000   },
      { start: 1_800_000, duration: 5_000   },
      { start: 2_400_000, duration: 5_000   },
      { start: 3_000_000, duration: 200_000 },   // genuinely slow: one breach
      // Enqueued mid-flight, so it cannot have started before 3_200_000.
      // Raw 105s; execution 5s.
      { start: 3_100_000, duration: 105_000 },
    ]

    const target = timeline.map((t) => ({
      function_id: TARGET,
      started_at:  at(t.start),
      finished_at: at(t.start + t.duration),
      duration_ms: t.duration,
    }))

    const others = WATCHED_JOBS
      .filter((j) => j.id !== TARGET)
      .map((j) => ({ function_id: j.id, started_at: hoursAgo(1), duration_ms: 1_000 }))

    const res = await run([...others, ...target])
    expect(res.slowJobs).toBe(0)
  })

  it('is a WARNING path — a slow job is still a running job', async () => {
    // Distinct from silence: slow means degraded, silent means stopped. They
    // are reported under different sites so one cannot be mistaken for the
    // other in triage.
    const logger = makeLogger()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        {
          system_job_runs: [{ data: runsWithDurations([4_000, 4_200, 3_900, 4_100, 400_000, 400_000]), error: null }],
          integration_connections: [{ data: [], error: null }],
        },
        [], RECORDING_MATURE,
      ),
    )

    await invokeHandler(systemWatchdog, { event: {}, step: runAllStep(), logger })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('slower than their norm'))
  })
})

// ============================================================================
// DUPLICATED CRON TICKS.
//
// An Inngest app can carry several SYNCS — one per deployment URL that has
// registered itself — and every sync receives every scheduler tick. A stale
// preview deployment nobody deleted therefore keeps executing the entire cron
// suite forever.
//
// On 2026-08-18 every cron in this system was running SIX times an hour that
// way, for weeks, and nothing noticed: each duplicate run SUCCEEDED, so CI was
// green, Sentry was quiet, the run ledger showed only successes, and the
// silence check was satisfied by definition — a job running six times over is
// the opposite of silent. The slow-job check could not see it either, since
// each individual run was a perfectly normal duration.
//
// The tell is the ULID. A run id's first 10 characters are its creation
// millisecond, so N runs of one function sharing one prefix are ONE tick fanned
// across N syncs — they cannot be N genuine ticks, because no cron schedule has
// millisecond granularity.
// ============================================================================
describe('systemWatchdog — duplicated cron ticks', () => {
  const TARGET = 'ownerrez-incremental-sync'

  /** A run id in the real shape: 10-char tick prefix + 16 chars of entropy. */
  const runId = (tick: string, entropy: string) => `${tick}${entropy.padEnd(16, '0')}`

  /**
   * `ticks` scheduler ticks for TARGET, each executed `fanout` times, plus
   * every other watched job once so nothing reports silent.
   */
  function runsWithFanout(ticks: number, fanout: number) {
    const others = WATCHED_JOBS
      .filter((j) => j.id !== TARGET)
      .map((j, i) => ({
        function_id: j.id,
        started_at:  hoursAgo(1),
        duration_ms: 1_000,
        run_id:      runId('01M0AJQZR0', `OTHER${i}`),
      }))

    const target = Array.from({ length: ticks }).flatMap((_, t) =>
      Array.from({ length: fanout }).map((__, f) => ({
        function_id: TARGET,
        started_at:  hoursAgo(ticks - t),
        duration_ms: 1_000,
        // Same prefix within a tick, different entropy per execution — exactly
        // what one tick delivered to several syncs produces.
        run_id: runId(`01M0AJQZ${String(t).padStart(2, 'A')}`, `SYNC${f}`),
      })),
    )

    return [...others, ...target]
  }

  function run(rows: unknown[]) {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase(
        { system_job_runs: [{ data: rows, error: null }], integration_connections: [{ data: [], error: null }] },
        [], RECORDING_MATURE,
      ),
    )
    return invokeHandler(systemWatchdog, {
      event: {}, step: runAllStep(), logger: makeLogger(),
    }) as Promise<{ duplicatedCrons: number; slowJobs: number; silentJobs: number }>
  }

  it('reports a cron whose every tick is executed twice', async () => {
    const res = await run(runsWithFanout(4, 2))

    expect(res.duplicatedCrons).toBe(1)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('2x per tick') }),
      expect.objectContaining({ site: 'inngest.system-watchdog.duplicated-crons' }),
    )
  })

  it('names the worst fanout, so a 6x is not reported as a 2x', async () => {
    // The real incident. The number is the whole actionable content: it says
    // how many stale syncs are registered.
    const res = await run(runsWithFanout(3, 6))
    expect(res.duplicatedCrons).toBe(1)
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('6x per tick') }),
      expect.anything(),
    )
  })

  /**
   * TARGET's ticks with a per-tick fanout, oldest first. `fanouts[i]` is how
   * many times tick i executed, so [2,2,1,1] reads "it was duplicated and then
   * stopped being duplicated".
   */
  function runsWithFanoutSequence(fanouts: number[]) {
    const others = WATCHED_JOBS
      .filter((j) => j.id !== TARGET)
      .map((j, i) => ({
        function_id: j.id,
        started_at:  hoursAgo(1),
        duration_ms: 1_000,
        run_id:      runId('01M0AJQZR0', `OTHER${i}`),
      }))

    const target = fanouts.flatMap((fanout, t) =>
      Array.from({ length: fanout }).map((__, f) => ({
        function_id: TARGET,
        started_at:  hoursAgo(fanouts.length - t),
        duration_ms: 1_000,
        run_id: runId(`01M0AJQZ${String(t).padStart(2, 'A')}`, `SYNC${f}`),
      })),
    )

    return [...others, ...target]
  }

  it('goes QUIET once the duplication stops, instead of reporting history', async () => {
    // 2026-08-20, production. The duplicate sync was removed around 01:00 and
    // the ledger showed zero duplicated ticks for the next fourteen hours — but
    // the scan reads a 31-hour window, so this alarm kept arriving every hour
    // and would have gone on until 08:00 the following day.
    //
    // Every one of those alerts was indistinguishable from a live one. An alarm
    // that cannot go out trains its reader to close it unread, which is fatal
    // for a check whose entire job is to be believed on a day when nothing else
    // notices.
    const res = await run(runsWithFanoutSequence([2, 2, 2, 2, 1, 1]))

    expect(res.duplicatedCrons, 'four historical duplicated ticks, but the recent ones are clean').toBe(0)
  })

  it('still reports duplication that is happening NOW', async () => {
    // The other half of the same property: going quiet on a fixed problem must
    // not mean going quiet on a live one.
    const res = await run(runsWithFanoutSequence([1, 1, 2, 2, 2, 2]))
    expect(res.duplicatedCrons).toBe(1)
  })

  it('is not silenced by a single clean latest tick', async () => {
    // Why the recency window is TWO ticks and not one: a run still in flight
    // when the watchdog fires records one row, not two, so its tick looks
    // clean. A one-tick window would let a long-running duplicated cron mask
    // itself forever.
    const res = await run(runsWithFanoutSequence([2, 2, 2, 2, 2, 1]))
    expect(res.duplicatedCrons).toBe(1)
  })

  it('stays quiet when every tick ran exactly once', async () => {
    const res = await run(runsWithFanout(6, 1))
    expect(res.duplicatedCrons).toBe(0)
  })

  it('does NOT report a SINGLE duplicated tick — that is deploy noise', async () => {
    // A deployment landing mid-tick briefly has two syncs live. Reporting one
    // occurrence would make this alarm flap on every deploy, and an alarm that
    // fires during normal operations is one an operator mutes.
    const rows = [
      ...runsWithFanout(5, 1),
      { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: runId('01M0AJQZ00', 'SYNC0') },
      { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: runId('01M0AJQZ00', 'SYNC1') },
    ]
    const res = await run(rows)
    expect(res.duplicatedCrons).toBe(0)
  })

  it('does NOT treat a repeated run_id as a duplicate execution', async () => {
    // A retry keeps its run_id, and (run_id, function_id) is unique in the
    // ledger anyway — so counting ROWS rather than DISTINCT run ids would
    // invent duplicates out of retries.
    // TWO ticks, each with its run id repeated — enough to clear
    // DUPLICATE_MIN_TICKS if rows were counted instead of distinct ids. With
    // three identical rows in a SINGLE tick the threshold masks the bug and
    // this test passes either way, which is what it did before it was fixed.
    const dupA = { function_id: TARGET, started_at: hoursAgo(2), duration_ms: 1_000, run_id: runId('01M0AJQZ00', 'SAMEA') }
    const dupB = { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: runId('01M0AJQZ01', 'SAMEB') }
    const res = await run([...runsWithFanout(5, 1), dupA, dupA, dupA, dupB, dupB])
    expect(res.duplicatedCrons).toBe(0)
  })

  it('ignores rows with a missing or truncated run id rather than grouping them', async () => {
    // Runs recorded before the id was captured must not all collapse into one
    // "tick" and report every job as massively duplicated.
    const rows = [
      ...runsWithFanout(5, 1),
      { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: '' },
      { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: '01M0' },
      { function_id: TARGET, started_at: hoursAgo(1), duration_ms: 1_000, run_id: null },
    ]
    const res = await run(rows)
    expect(res.duplicatedCrons).toBe(0)
  })

  it('does not scan event-driven fan-out handlers, whose same-ms runs are correct', async () => {
    // daily-wrapup-org fires once per org and ownerrez-connection-sync once per
    // connection, both dispatched in a single step.sendEvent — so they SHOULD
    // show many runs in one millisecond. Only WATCHED_JOBS (all cron-triggered)
    // are scanned, which is what keeps this from reporting normal behaviour.
    const rows = [
      ...runsWithFanout(5, 1),
      // THREE separate dispatches of 8 orgs each. One dispatch would sit below
      // DUPLICATE_MIN_TICKS and pass even if handlers were scanned — the
      // threshold, not the scope rule, would be doing the work.
      ...['01M0AJQZZA', '01M0AJQZZB', '01M0AJQZZC'].flatMap((tick) =>
        Array.from({ length: 8 }).map((_, i) => ({
          function_id: 'daily-wrapup-org',
          started_at:  hoursAgo(1),
          duration_ms: 1_000,
          run_id:      runId(tick, `ORG${i}`),
        })),
      ),
    ]
    const res = await run(rows)
    expect(res.duplicatedCrons).toBe(0)
  })
})
