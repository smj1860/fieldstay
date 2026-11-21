import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const state = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.client }))

import { reportError } from '@/lib/observability/report-error'
import { writeBrief, type Gathered, type RunRequest } from '@/lib/inngest/functions/gtm-manager'
import { buildMetrics } from '@/lib/gtm/manager/brief'
import { parseRollup } from '@/lib/gtm/rollup'
import { fakeSupabase, type Scripted } from './fake-supabase'

// ============================================================================
// The write step is where a retried Inngest run can quietly lose money: the
// brief and the spend are two inserts, so an attempt can die between them.
// ============================================================================

const gathered: Gathered = {
  skip: false, autonomy: 'propose_only', narrate: true, dateKey: '2026-11-18',
  metrics: buildMetrics(parseRollup({ funnel: { new: 3 } }), [], new Date('2026-11-18T12:00:00Z')),
}
const scheduled: RunRequest = { kind: 'morning_plan', scheduled: true, requestedBy: null, replayKey: '' }
const manual: RunRequest = { kind: 'manual', scheduled: false, requestedBy: 'admin_1', replayKey: 'evt_1' }
const narration = { ok: true as const, text: 'Calm day.', model: 'claude-haiku-4-5-20251001', inputTokens: 300, outputTokens: 40 }

function world(script: Record<string, Scripted[]>) {
  const fake = fakeSupabase(script)
  state.client = fake.client
  return fake
}

beforeEach(() => { vi.clearAllMocks() })

describe('writeBrief', () => {
  it('writes the brief, then the spend, keyed to the same slot', async () => {
    const { calls } = world({ 'manager_decisions:insert': [{ error: null }], 'agent_usage:insert': [{ error: null }] })
    expect(await writeBrief(scheduled, gathered, narration)).toEqual({ written: true })

    expect(calls[0]).toMatchObject({ table: 'manager_decisions', payload: expect.objectContaining({
      kind: 'morning_plan', dedupe_key: 'morning_plan:2026-11-18', actions: [], model: 'claude-haiku-4-5-20251001', autonomy_at_run: 'propose_only',
    }) })
    expect(calls[1]).toMatchObject({ table: 'agent_usage', payload: expect.objectContaining({
      team: 'manager', dedupe_key: 'manager:morning_plan:2026-11-18', input_tokens: 300,
    }) })
  })

  it('creates no tasks, whatever it reads: the manager is observe-only', async () => {
    const { calls } = world({ 'manager_decisions:insert': [{ error: null }], 'agent_usage:insert': [{ error: null }] })
    await writeBrief(scheduled, gathered, narration)
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
  })

  it('records no spend and no model when there is no narrative', async () => {
    const { calls } = world({ 'manager_decisions:insert': [{ error: null }] })
    await writeBrief(scheduled, gathered, null)
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toMatchObject({ model: null })
    await writeBrief(scheduled, gathered, { ok: false, reason: 'error' })
    expect(calls.filter((c) => c.table === 'agent_usage')).toHaveLength(0)
  })

  // The bug this exists for: attempt 1 wrote the brief and died before the spend.
  // The retry hits the duplicate-key path. Stopping there loses the spend for good.
  it('still records the spend when a retry finds the brief already written', async () => {
    const { calls } = world({
      'manager_decisions:insert': [{ error: { code: '23505', message: 'duplicate key' } }],
      'agent_usage:insert': [{ error: null }],
    })
    expect(await writeBrief(scheduled, gathered, narration)).toEqual({ written: false })
    expect(calls.filter((c) => c.table === 'agent_usage')).toHaveLength(1)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('does not double-bill when the spend was already recorded too', async () => {
    world({
      'manager_decisions:insert': [{ error: { code: '23505', message: 'dup' } }],
      'agent_usage:insert': [{ error: { code: '23505', message: 'dup' } }],
    })
    await expect(writeBrief(scheduled, gathered, narration)).resolves.toEqual({ written: false })
  })

  it('keys a manual run on its event, so a replayed event cannot write two briefs', async () => {
    const { calls } = world({ 'manager_decisions:insert': [{ error: null }], 'agent_usage:insert': [{ error: null }] })
    await writeBrief(manual, gathered, narration)
    expect(calls[0].payload).toMatchObject({ kind: 'manual', requested_by: 'admin_1', dedupe_key: 'manual:evt_1' })
    expect(calls[1].payload).toMatchObject({ dedupe_key: 'manager:manual:evt_1' })
  })

  it('throws, and reports, on any other failure writing the brief', async () => {
    world({ 'manager_decisions:insert': [{ error: { code: '42501', message: 'denied' } }] })
    await expect(writeBrief(scheduled, gathered, narration)).rejects.toMatchObject({ code: '42501' })
    expect(reportError).toHaveBeenCalled()
  })
})
