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
// ============================================================================

function makeSupabase(insertError: { message: string } | null) {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    upsert: vi.fn(() => Promise.resolve({ data: null, error: insertError })),
  })
  return { from: vi.fn(() => chain) } as never
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

const FINISHED_EVENT = {
  data: { function_id: 'fieldstay-cron-daily-wrapup', run_id: '01J0A50H80EXAMPLE0000' },
  ts:   1_726_000_000_000,
}

beforeEach(() => vi.clearAllMocks())

describe('jobRunRecorder', () => {
  it('reports to Sentry, not just the logger, when the insert fails', async () => {
    const supabase = makeSupabase({ message: 'relation "system_job_runs" does not exist' })
    vi.mocked(createServiceClient).mockReturnValue(supabase)
    const logger = makeLogger()

    await invokeHandler(jobRunRecorder, { event: FINISHED_EVENT, step: makeStep(), logger })

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
    vi.mocked(createServiceClient).mockReturnValue(supabase)

    await invokeHandler(jobRunRecorder, { event: FINISHED_EVENT, step: makeStep(), logger: makeLogger() })

    expect(reportError).not.toHaveBeenCalled()
  })
})
