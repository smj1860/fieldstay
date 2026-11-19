import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requirePlatformAdmin: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import { decideAgentTask, markDraftSent, requestManagerRun, requestRevOpsReport, updateTeamSettings } from '@/app/admin/prospects/agents-actions'
import { fakeSupabase, type Scripted } from '../gtm/fake-supabase'

function asAdmin(script: Record<string, Scripted[]>) {
  const fake = fakeSupabase(script)
  vi.mocked(requirePlatformAdmin).mockResolvedValue({ supabase: fake.client, user: { id: 'admin_1' } } as never)
  return fake
}

beforeEach(() => { vi.clearAllMocks() })

describe('decideAgentTask', () => {
  const row = { id: 't1', team: 'sales_ops', task_type: 'follow_up_email' }

  it('approves a waiting item, records who and when, audits it and wakes the owning team', async () => {
    const { calls } = asAdmin({ 'agent_tasks:update': [{ data: row, error: null }] })
    expect(await decideAgentTask('t1', 'approve', '  looks good  ')).toEqual({})

    const update = calls[0]
    expect(update.payload).toMatchObject({ status: 'approved', decided_by: 'admin_1', decision_note: 'looks good' })
    // The guard that makes a double-click safe is on the UPDATE itself.
    expect(update.filters).toContainEqual(['in', ['status', ['needs_approval']]])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.gtm_task.decided', targetId: 't1', metadata: { decision: 'approve', team: 'sales_ops', task_type: 'follow_up_email' },
    }))
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'gtm/task.approved', data: { task_id: 't1', team: 'sales_ops', task_type: 'follow_up_email', decided_by: 'admin_1' },
    })
  })

  it('does not wake the team for a rejection', async () => {
    asAdmin({ 'agent_tasks:update': [{ data: row, error: null }] })
    expect(await decideAgentTask('t1', 'reject')).toEqual({})
    expect(inngest.send).not.toHaveBeenCalled()
  })

  // Two admins, or one admin with two tabs, can both see the same draft.
  it('tells the second person it was already handled, instead of overwriting the first decision', async () => {
    asAdmin({ 'agent_tasks:update': [{ data: null, error: null }] })
    expect(await decideAgentTask('t1', 'approve')).toEqual({ error: 'That item was already handled.' })
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('never puts the draft itself in the audit row', async () => {
    asAdmin({ 'agent_tasks:update': [{ data: row, error: null }] })
    await decideAgentTask('t1', 'approve', 'send it to dana@example.com')
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain('dana@example.com')
  })

  it('refuses an unknown decision without touching the database', async () => {
    const { calls } = asAdmin({})
    expect(await decideAgentTask('t1', 'delete')).toEqual({ error: 'Unknown decision.' })
    expect(calls).toHaveLength(0)
  })

  it('keeps the approval even if the wake-up event fails to send', async () => {
    asAdmin({ 'agent_tasks:update': [{ data: row, error: null }] })
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('down'))
    expect(await decideAgentTask('t1', 'approve')).toEqual({})
  })

  it('truncates an over-long note', async () => {
    const { calls } = asAdmin({ 'agent_tasks:update': [{ data: row, error: null }] })
    await decideAgentTask('t1', 'reject', 'n'.repeat(2_000))
    expect((calls[0].payload as { decision_note: string }).decision_note).toHaveLength(500)
  })

  it('returns a generic message on a database error, not the raw one', async () => {
    asAdmin({ 'agent_tasks:update': [{ data: null, error: { code: '42501', message: 'permission denied for table agent_tasks' } }] })
    expect(await decideAgentTask('t1', 'approve')).toEqual({ error: 'Operation failed. Please try again.' })
  })
})

describe('updateTeamSettings', () => {
  it('saves a valid edit, stamps who made it, and audits the fields changed', async () => {
    const { calls } = asAdmin({ 'gtm_team_settings:update': [{ data: { team: 'lead_gen' }, error: null }] })
    expect(await updateTeamSettings('lead_gen', { enabled: true, daily_task_cap: 20 })).toEqual({})
    expect(calls[0].payload).toEqual({ enabled: true, daily_task_cap: 20, updated_by: 'admin_1' })
    expect(calls[0].filters).toContainEqual(['eq', ['team', 'lead_gen']])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.gtm_team.updated', targetId: 'lead_gen',
    }))
  })

  it('refuses an invalid edit before it reaches the database', async () => {
    const { calls } = asAdmin({})
    expect(await updateTeamSettings('lead_gen', { daily_task_cap: -3 })).toHaveProperty('error')
    expect(await updateTeamSettings('manager', { autonomy: 'auto_low_risk' })).toHaveProperty('error')
    expect(calls).toHaveLength(0)
  })

  it('reports a team whose row is missing', async () => {
    asAdmin({ 'gtm_team_settings:update': [{ data: null, error: null }] })
    expect(await updateTeamSettings('lead_gen', { enabled: true })).toEqual({ error: 'That team has no settings row.' })
  })
})

describe('requestManagerRun', () => {
  it('sends the event with the requester and audits it', async () => {
    asAdmin({})
    expect(await requestManagerRun()).toEqual({})
    expect(inngest.send).toHaveBeenCalledWith({ name: 'gtm/manager.run.requested', data: { requested_by: 'admin_1' } })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_manager.run_requested' }))
  })

  it('says so when the request could not be sent', async () => {
    asAdmin({})
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('down'))
    expect(await requestManagerRun()).toEqual({ error: 'Could not start the manager. Please try again.' })
  })
})

describe('requestRevOpsReport', () => {
  const settings = (rev: boolean, master = true) => ({
    'gtm_team_settings:select': [{ data: [
      { team: 'global', enabled: master, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
      { team: 'rev_ops', enabled: rev, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
    ], error: null }],
  })

  it('sends the request and audits it when Rev Ops can run', async () => {
    asAdmin(settings(true))
    expect(await requestRevOpsReport()).toEqual({})
    expect(inngest.send).toHaveBeenCalledWith({ name: 'gtm/rev-ops.report.requested', data: { requested_by: 'admin_1' } })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_rev_ops.report_requested' }))
  })

  // The queue would refuse the task, so the button would look like it worked and nothing would appear.
  it.each([[false, true], [true, false]])('refuses up front, and sends nothing, when Rev Ops is %s and the master switch is %s', async (rev, master) => {
    asAdmin(settings(rev, master))
    expect(await requestRevOpsReport()).toEqual({ error: 'Turn on the master switch and Rev Ops first.' })
    expect(inngest.send).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('says so when the request could not be sent', async () => {
    asAdmin(settings(true))
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('down'))
    expect(await requestRevOpsReport()).toEqual({ error: 'Could not request the report. Please try again.' })
  })
})

describe('markDraftSent', () => {
  const sent = (status = 'queued', over: Record<string, Scripted[]> = {}) => asAdmin({
    'agent_tasks:update':       [{ data: { id: 't1', prospect_id: 'p1' }, error: null }],
    'prospect_accounts:select': [{ data: { status }, error: null }],
    'prospect_accounts:update': [{ error: null }],
    'prospect_touches:insert':  [{ error: null }],
    ...over,
  })

  it('closes the draft, stamps the account and logs an emailed touch, then audits it', async () => {
    const { calls } = sent('queued')
    expect(await markDraftSent('t1')).toEqual({})

    const closeIt = calls.find((c) => c.table === 'agent_tasks')!
    expect(closeIt.payload).toEqual({ status: 'done' })
    expect(calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload)
      .toMatchObject({ status: 'emailed', last_touch_at: expect.any(String) })
    expect(calls.find((c) => c.table === 'prospect_touches')!.payload)
      .toMatchObject({ prospect_id: 'p1', touch_type: 'emailed', actor_id: 'admin_1' })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_draft.marked_sent', targetId: 't1' }))
  })

  // A follow-up going out must never push an account that already replied back to "emailed".
  it.each(['replied', 'meeting_set', 'in_trial', 'emailed', 'called'])('does not change the stage of an account that is %s, only its last-touch time', async (status) => {
    const { calls } = sent(status)
    await markDraftSent('t1')
    const update = calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload as Record<string, unknown>
    expect(update).not.toHaveProperty('status')
    expect(update).toHaveProperty('last_touch_at')
  })

  // Two tabs, or a double click: the UPDATE only matches while the draft is still approved.
  it('records one send only, and tells the second click it was already handled', async () => {
    const { calls } = sent('queued', { 'agent_tasks:update': [{ data: null, error: null }] })
    expect(await markDraftSent('t1')).toEqual({ error: 'That draft was already handled.' })
    expect(calls.some((c) => c.table === 'prospect_touches')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('only ever closes a Sales Ops draft that is still approved', async () => {
    const { calls } = sent()
    await markDraftSent('t1')
    const filters = calls.find((c) => c.table === 'agent_tasks')!.filters
    expect(filters).toContainEqual(['eq', ['status', 'approved']])
    expect(filters).toContainEqual(['eq', ['team', 'sales_ops']])
    expect(filters).toContainEqual(['eq', ['task_type', 'draft_outreach']])
  })

  // The task is already closed by then, so silence would lose the touch without anyone knowing.
  it('says so when the draft was closed but the account could not be updated', async () => {
    sent('queued', { 'prospect_touches:insert': [{ error: { message: 'boom' } }] })
    expect(await markDraftSent('t1')).toEqual({ error: 'Marked as sent, but the account could not be updated. Log the email on the account by hand.' })
  })

  it('returns a generic message on a database error, not the raw one', async () => {
    sent('queued', { 'agent_tasks:update': [{ data: null, error: { code: '42501', message: 'permission denied' } }] })
    expect(await markDraftSent('t1')).toEqual({ error: 'Operation failed. Please try again.' })
  })

  it('closes a draft that names no account without trying to write one', async () => {
    const { calls } = sent('queued', { 'agent_tasks:update': [{ data: { id: 't1', prospect_id: null }, error: null }] })
    expect(await markDraftSent('t1')).toEqual({})
    expect(calls.some((c) => c.table === 'prospect_accounts')).toBe(false)
  })
})
