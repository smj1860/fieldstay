import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, handler: unknown) => handler },
}))

import { createServiceClient } from '@/lib/supabase/server'
import { frictionGrading } from '@/lib/inngest/functions/cron/friction-grading'

// The cron is a thin shell over apply_friction_grading() — the grading LOGIC
// is SQL and is verified against the live function, not mocked here. What
// these cover is the shell: that it calls the right RPC, reports what came
// back, and fails loudly rather than reporting a silent success.

const runHandler = () => {
  const step = { run: vi.fn(async (_name: string, fn: () => unknown) => fn()) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { step, logger, invoke: () => (frictionGrading as unknown as
    (a: { step: typeof step; logger: typeof logger }) => Promise<{ graded: number }>)({ step, logger }) }
}

describe('cron: friction grading', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls apply_friction_grading and reports the count', async () => {
    const rpc = vi.fn(async () => ({ data: { graded: 7 }, error: null }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({ rpc })

    const { invoke, logger } = runHandler()
    expect(await invoke()).toEqual({ graded: 7 })
    expect(rpc).toHaveBeenCalledWith('apply_friction_grading')
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('7'))
  })

  it('throws on an RPC error rather than reporting a silent success', async () => {
    // A swallowed error here would log "graded 0" forever while the loop was
    // dead — the calibration view would just look like there is no data yet.
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied' } }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({ rpc })

    const { invoke } = runHandler()
    await expect(invoke()).rejects.toThrow(/apply_friction_grading failed: permission denied/)
  })

  it('passes no arguments to the RPC — grading takes no parameters', async () => {
    const rpc = vi.fn(async () => ({ data: { graded: 0 }, error: null }))
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({ rpc })

    const { invoke } = runHandler()
    await invoke()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0]).toEqual(['apply_friction_grading'])
  })
})
