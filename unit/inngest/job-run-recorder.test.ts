import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { jobRunRecorder } from '@/lib/inngest/functions/cron/job-run-recorder'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// ============================================================================
// system_job_runs exists to catch ABSENCE — a cron that stopped running with
// no error anywhere to catch it (see the module's own header comment: the
// geocoding backfill and a rotated Hospitable secret both went undetected for
// this exact reason). That guarantee depends entirely on this recorder's own
// insert actually landing.
//
// It used to fail only into logger.error() — Axiom, not Sentry — which is
// exactly how the 'completed'/'succeeded' CHECK-constraint mismatch this file
// documents ran silently in production for 47 minutes: nothing was watching
// this cron's own function logs. reportError() is what makes a second such
// failure (schema drift, an RLS change, the table disappearing) visible
// without someone happening to notice the ledger went quiet.
//
// BATCHED as of 2026-09-16: the handler now destructures `events` (plural,
// Inngest's batchEvents shape) rather than a single `event`, and writes one
// multi-row upsert per invocation. These tests exercise that directly —
// `events` always an array here, one element for the pre-batching-equivalent
// cases and several for the batch-specific ones.
// ============================================================================

interface UpsertRow {
  function_id: string
  run_id:      string
  status:      string
}

function makeSupabase(insertError: { message: string } | null) {
  // Typed with two real params (rows, opts) rather than inferred from a
  // zero-arg arrow — vi.fn()'s call-tuple type otherwise comes out `[]`
  // regardless of what it's actually invoked with, which is what made
  // `.mock.calls[0]` unindexable at the type level even though the runtime
  // call has two args.
  const upsert = vi.fn((_rows: UpsertRow[], _opts: unknown) => Promise.resolve({ data: null, error: insertError }))
  const chain: Record<string, unknown> = { upsert }
  return { from: vi.fn(() => chain), _upsert: upsert } as unknown as { from: ReturnType<typeof vi.fn>; _upsert: typeof upsert }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

function finishedEvent(functionId: string, runId: string, ts = 1_726_000_000_000, error?: { message: string }) {
  return { data: { function_id: functionId, run_id: runId, ...(error ? { error } : {}) }, ts }
}

const FINISHED_EVENT = finishedEvent('fieldstay-cron-daily-wrapup', '01J0A50H80EXAMPLE0000')

beforeEach(() => vi.clearAllMocks())

describe('jobRunRecorder', () => {
  it('reports to Sentry, not just the logger, when the insert fails', async () => {
    const supabase = makeSupabase({ message: 'relation "system_job_runs" does not exist' })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const logger = makeLogger()

    await invokeHandler(jobRunRecorder, { event: null, events: [FINISHED_EVENT], step: makeStep(), logger })

    expect(logger.error).toHaveBeenCalled()
    // The bug this guards: a logger-only failure is invisible outside Axiom,
    // which nobody watches for a system heartbeat cron. reportError() is the
    // channel that actually pages/alerts.
    expect(reportError).toHaveBeenCalledTimes(1)
    const [err, ctx] = vi.mocked(reportError).mock.calls[0]!
    expect((err as { message: string }).message).toContain('does not exist')
    expect(ctx).toMatchObject({ site: 'inngest.job-run-recorder', level: 'warning' })
  })

  it('does not report anything when the insert succeeds', async () => {
    const supabase = makeSupabase(null)
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await invokeHandler(jobRunRecorder, { event: null, events: [FINISHED_EVENT], step: makeStep(), logger: makeLogger() })

    expect(reportError).not.toHaveBeenCalled()
  })

  describe('batching (2026-09-16 scalability pass)', () => {
    it('writes a batch of several finished events as ONE multi-row upsert', async () => {
      const supabase = makeSupabase(null)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const batch = [
        finishedEvent('fieldstay-cron-daily-wrapup', 'run_1'),
        finishedEvent('fieldstay-cron-asset-health', 'run_2'),
        finishedEvent('fieldstay-cron-metrics-snapshot', 'run_3', undefined, { message: 'boom' }),
      ]

      const result = await invokeHandler(jobRunRecorder, { event: null, events: batch, step: makeStep(), logger: makeLogger() })

      // ONE call to upsert, not one per event — the entire point of batching.
      expect(supabase._upsert).toHaveBeenCalledTimes(1)
      const [rows, opts] = supabase._upsert.mock.calls[0]!
      expect(rows).toHaveLength(3)
      expect(opts).toMatchObject({ onConflict: 'run_id,function_id', ignoreDuplicates: true })
      // Per-row status is still derived correctly inside the batch.
      expect(rows.map((r) => r.status)).toEqual([
        'succeeded', 'succeeded', 'failed',
      ])
      expect(result).toMatchObject({ recorded: 3, skippedSelf: 0, skippedNoId: 0 })
    })

    it('filters its OWN completion out of a batch without dropping the rest', async () => {
      const supabase = makeSupabase(null)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const batch = [
        finishedEvent('fieldstay-job-run-recorder', 'self_run'),
        finishedEvent('fieldstay-cron-daily-wrapup', 'run_1'),
      ]

      const result = await invokeHandler(jobRunRecorder, { event: null, events: batch, step: makeStep(), logger: makeLogger() })

      expect(supabase._upsert).toHaveBeenCalledTimes(1)
      const [rows] = supabase._upsert.mock.calls[0]!
      expect(rows).toHaveLength(1)
      expect(rows[0].function_id).toBe('cron-daily-wrapup')
      expect(result).toMatchObject({ recorded: 1, skippedSelf: 1 })
    })

    it('skips a malformed event with no function_id, logs it, and still records the rest of the batch', async () => {
      const supabase = makeSupabase(null)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const logger = makeLogger()

      const batch = [
        { data: { run_id: 'orphan_run' }, ts: 1_726_000_000_000 },
        finishedEvent('fieldstay-cron-daily-wrapup', 'run_1'),
      ]

      const result = await invokeHandler(jobRunRecorder, { event: null, events: batch, step: makeStep(), logger })

      expect(logger.warn).toHaveBeenCalled()
      expect(supabase._upsert).toHaveBeenCalledTimes(1)
      const [rows] = supabase._upsert.mock.calls[0]!
      expect(rows).toHaveLength(1)
      expect(result).toMatchObject({ recorded: 1, skippedNoId: 1 })
    })

    it('never calls upsert at all when every event in the batch is filtered out', async () => {
      const supabase = makeSupabase(null)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const batch = [finishedEvent('fieldstay-job-run-recorder', 'self_run')]

      const result = await invokeHandler(jobRunRecorder, { event: null, events: batch, step: makeStep(), logger: makeLogger() })

      expect(supabase._upsert).not.toHaveBeenCalled()
      expect(result).toMatchObject({ recorded: 0, skippedSelf: 1 })
    })
  })
})
