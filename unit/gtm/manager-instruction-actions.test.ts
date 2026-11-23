import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: vi.fn(() => ({})), send: vi.fn() } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

const state = vi.hoisted(() => ({ session: null as unknown, service: null as unknown, apply: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => ({ user: { id: 'admin_1' }, supabase: state.session }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.service }))
vi.mock('@/lib/gtm/manager/apply', async (orig) => ({
  ...(await orig<typeof import('@/lib/gtm/manager/apply')>()),
  applyAction: state.apply,
}))

import { inngest } from '@/lib/inngest/client'
import { decideManagerInstruction, setStandingPermission, submitManagerInstruction } from '@/app/admin/prospects/manager-instruction-actions'
import { fakeSupabase, type Scripted } from './fake-supabase'

// ============================================================================
// The three things a person can do to the manager's instructions. What matters
// most: a reply becomes work only through an approval that wins a status
// guard, and a standing permission cannot be granted for a type nobody has
// approved enough, whatever a hand-built request says.
// ============================================================================

const on = (team: string) => ({ team, enabled: true, autonomy: 'propose_only', daily_task_cap: 10, daily_cost_cap_cents: 100 })
const human = (day: string) => ({ source: 'human', status: 'applied', action_kinds: ['run_funnel_report'], decided_at: `${day}T15:00:00Z` })

function world(session: Record<string, Scripted[]>, service: Record<string, Scripted[]> = {}) {
  const s = fakeSupabase(session)
  const v = fakeSupabase(service)
  state.session = s.client
  state.service = v.client
  return { session: s, service: v }
}

beforeEach(() => { vi.clearAllMocks() })

describe('submitManagerInstruction', () => {
  it('refuses while the manager is switched off, and writes nothing', async () => {
    const { service } = world({ 'gtm_team_settings:select': [{ data: [on('global')], error: null }] })
    const out = await submitManagerInstruction('retry the failed drafts', null)
    expect(out.error).toMatch(/switched off/)
    expect(service.calls).toHaveLength(0)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('stores the reply and wakes the manager to read it', async () => {
    const { service } = world(
      { 'gtm_team_settings:select': [{ data: [on('global'), on('manager')], error: null }], 'manager_instructions:select': [{ count: 0, error: null }] },
      { 'manager_instructions:insert': [{ data: { id: 'i1' }, error: null }] },
    )
    expect(await submitManagerInstruction('  retry the failed drafts ', 'not-a-uuid')).toEqual({})
    expect(service.calls[0].payload).toMatchObject({ source: 'human', instruction: 'retry the failed drafts', brief_id: null, requested_by: 'admin_1' })
    expect(inngest.send).toHaveBeenCalledWith({ name: 'gtm/manager.instruction.submitted', data: { instruction_id: 'i1' } })
  })
})

describe('decideManagerInstruction', () => {
  const proposal = [{ kind: 'run_funnel_report', params: {} }]

  it('carries out an approved proposal and records what happened', async () => {
    state.apply.mockResolvedValue({ kind: 'run_funnel_report', ok: true, summary: 'Asked Rev Ops for a funnel report.' })
    const { service } = world({}, {
      'manager_instructions:update': [{ data: { id: 'i1', proposal }, error: null }, { error: null }],
    })
    const out = await decideManagerInstruction('i1', 'approve')
    expect(out.summary).toBe('Asked Rev Ops for a funnel report.')
    expect(service.calls[0].payload).toMatchObject({ status: 'applying', decided_by: 'admin_1' })
    expect(service.calls[0].filters).toContainEqual(['eq', ['status', 'proposed']])
    expect(service.calls[1].payload).toMatchObject({ status: 'applied' })
  })

  it('decides the manager\'s own plan as it decides a reply: the claim covers both sources', async () => {
    state.apply.mockResolvedValue({ kind: 'run_funnel_report', ok: true, summary: 'ok' })
    const { service } = world({}, { 'manager_instructions:update': [{ data: { id: 'i1', proposal }, error: null }, { error: null }] })
    await decideManagerInstruction('i1', 'approve')
    expect(service.calls[0].filters).toContainEqual(['in', ['source', ['human', 'manager']]])
    expect(service.calls[0].filters).toContainEqual(['eq', ['status', 'proposed']])
  })

  it('does nothing when the proposal was already decided: the guard matched no row', async () => {
    world({}, { 'manager_instructions:update': [{ data: null, error: null }] })
    const out = await decideManagerInstruction('i1', 'approve')
    expect(out.error).toMatch(/already decided/)
    expect(state.apply).not.toHaveBeenCalled()
  })

  it('a rejection carries nothing out', async () => {
    const { service } = world({}, { 'manager_instructions:update': [{ data: { id: 'i1', proposal }, error: null }] })
    expect(await decideManagerInstruction('i1', 'reject')).toEqual({ summary: undefined })
    expect(service.calls[0].payload).toMatchObject({ status: 'rejected' })
    expect(state.apply).not.toHaveBeenCalled()
  })

  it('marks it failed, not applied, when an action could not be carried out', async () => {
    state.apply.mockRejectedValue(new Error('boom'))
    const { service } = world({}, { 'manager_instructions:update': [{ data: { id: 'i1', proposal }, error: null }, { error: null }] })
    await decideManagerInstruction('i1', 'approve')
    expect(service.calls[1].payload).toMatchObject({ status: 'failed' })
  })
})

describe('setStandingPermission', () => {
  const approved = [human('2026-11-01'), human('2026-11-08'), human('2026-11-15')]

  it('refuses a type that has not been approved often enough, however it was asked', async () => {
    const { service } = world({ 'manager_instructions:select': [{ data: [human('2026-11-01')], error: null }] })
    const out = await setStandingPermission('run_funnel_report', true)
    expect(out.error).toMatch(/not approved this type often enough/)
    expect(service.calls).toHaveLength(0)
  })

  it('refuses a type that has ever been rejected', async () => {
    const rejected = { source: 'human', status: 'rejected', action_kinds: ['run_funnel_report'], decided_at: '2026-11-16T15:00:00Z' }
    world({ 'manager_instructions:select': [{ data: [...approved, rejected], error: null }] })
    expect((await setStandingPermission('run_funnel_report', true)).error).toBeDefined()
  })

  it('refuses a type that is not in the catalog', async () => {
    world({})
    expect(await setStandingPermission('send_email', true)).toEqual({ error: 'Unknown instruction type.' })
  })

  it('grants a type that has earned it, recording who granted it', async () => {
    const { service } = world(
      { 'manager_instructions:select': [{ data: approved, error: null }] },
      { 'manager_playbook:upsert': [{ error: null }] },
    )
    expect(await setStandingPermission('run_funnel_report', true)).toEqual({})
    expect(service.calls[0].payload).toMatchObject({ action_kind: 'run_funnel_report', standing: true, granted_by: 'admin_1' })
  })

  it('lets a person take a permission back at any time, with no history check', async () => {
    const { session, service } = world({}, { 'manager_playbook:upsert': [{ error: null }] })
    expect(await setStandingPermission('run_funnel_report', false)).toEqual({})
    expect(session.calls).toHaveLength(0)
    expect(service.calls[0].payload).toMatchObject({ standing: false, granted_by: null })
  })
})
