import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requirePlatformAdmin: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ service: true })) }))
vi.mock('@/lib/gtm/tasks', async (importActual) => ({ ...(await importActual<typeof import('@/lib/gtm/tasks')>()), enqueueTask: vi.fn() }))

import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import { enqueueTask } from '@/lib/gtm/tasks'
import { decideAgentTask, markCallMade, markDraftSent, markProspectReplied, requestCallBrief, requestQueueProposal, requestManagerRun, requestRevOpsReport, updateTeamSettings } from '@/app/admin/prospects/agents-actions'
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

describe('requestCallBrief', () => {
  const ID = '5b0a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
  const settings = (salesOps: boolean, master = true) => ({
    'gtm_team_settings:select': [{ data: [
      { team: 'global', enabled: master, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
      { team: 'sales_ops', enabled: salesOps, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
    ], error: null }],
  })
  const ready = (status = 'emailed', over: Record<string, Scripted[]> = {}) => asAdmin({
    ...settings(true),
    'prospect_accounts:select': [{ data: { id: ID, status }, error: null }],
    ...over,
  })

  it('queues a human-origin, approval-required brief, once per account per day, and audits it', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'task_9' })
    ready()
    expect(await requestCallBrief(ID)).toEqual({})
    expect(enqueueTask).toHaveBeenCalledWith({ service: true }, expect.objectContaining({
      team: 'sales_ops', taskType: 'call_brief', origin: 'human', prospectId: ID, requiresApproval: true,
      dedupeKey: expect.stringMatching(new RegExp(`^sales_ops:call_brief:${ID}:\\d{4}-\\d{2}-\\d{2}$`)),
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_call_brief.requested', targetId: 'task_9' }))
  })

  it.each([[false, true], [true, false]])('refuses up front when Sales Ops is %s and the master switch is %s', async (salesOps, master) => {
    asAdmin(settings(salesOps, master))
    expect(await requestCallBrief(ID)).toEqual({ error: 'Turn on the master switch and Sales Ops first.' })
    expect(enqueueTask).not.toHaveBeenCalled()
  })

  it.each(['won', 'lost', 'disqualified'])('refuses a closed account (%s) without queueing anything', async (status) => {
    ready(status)
    expect(await requestCallBrief(ID)).toEqual({ error: 'That account is closed, so there is nothing to prepare.' })
    expect(enqueueTask).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a uuid, and an account that is gone', async () => {
    asAdmin({})
    expect(await requestCallBrief('not-an-id')).toEqual({ error: 'Unknown account.' })
    ready('emailed', { 'prospect_accounts:select': [{ data: null, error: null }] })
    expect(await requestCallBrief(ID)).toEqual({ error: 'That account no longer exists.' })
    expect(enqueueTask).not.toHaveBeenCalled()
  })

  it.each([
    ['duplicate', 'A call brief for this account was already requested today. Check the approval inbox.'],
    ['task_cap', 'Sales Ops has reached its daily task cap.'],
    ['cost_cap', 'Sales Ops has reached its daily spend cap.'],
  ] as const)('says why the queue refused (%s), and audits nothing', async (reason, message) => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: false, reason })
    ready()
    expect(await requestCallBrief(ID)).toEqual({ error: message })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('returns a generic message on a failure, not the raw one', async () => {
    ready('emailed', { 'prospect_accounts:select': [{ data: null, error: { message: 'permission denied' } }] })
    expect(await requestCallBrief(ID)).toEqual({ error: 'Could not prepare the brief. Please try again.' })
  })
})

describe('markCallMade', () => {
  const called = (status = 'queued', over: Record<string, Scripted[]> = {}) => asAdmin({
    'agent_tasks:update':       [{ data: { id: 't1', prospect_id: 'p1' }, error: null }],
    'prospect_accounts:select': [{ data: { status }, error: null }],
    'prospect_accounts:update': [{ error: null }],
    'prospect_touches:insert':  [{ error: null }],
    ...over,
  })

  it('closes the brief, logs a called touch and stamps the account, then audits it', async () => {
    const { calls } = called('queued')
    expect(await markCallMade('t1')).toEqual({})
    expect(calls.find((c) => c.table === 'agent_tasks')!.payload).toEqual({ status: 'done' })
    expect(calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload).toMatchObject({ status: 'called', last_touch_at: expect.any(String) })
    expect(calls.find((c) => c.table === 'prospect_touches')!.payload).toMatchObject({ prospect_id: 'p1', touch_type: 'called', actor_id: 'admin_1' })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_call.marked_made', targetId: 't1' }))
  })

  // A call to someone who already replied must never move them back a stage.
  it.each(['emailed', 'called', 'replied', 'meeting_set', 'in_trial'])('leaves the stage of an account that is %s alone', async (status) => {
    const { calls } = called(status)
    await markCallMade('t1')
    expect(calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload).not.toHaveProperty('status')
  })

  it('only ever closes a Sales Ops call brief that is still approved', async () => {
    const { calls } = called()
    await markCallMade('t1')
    const filters = calls.find((c) => c.table === 'agent_tasks')!.filters
    expect(filters).toContainEqual(['eq', ['status', 'approved']])
    expect(filters).toContainEqual(['eq', ['team', 'sales_ops']])
    expect(filters).toContainEqual(['eq', ['task_type', 'call_brief']])
  })

  it('records one call only: a second click is told it was already handled', async () => {
    const { calls } = called('queued', { 'agent_tasks:update': [{ data: null, error: null }] })
    expect(await markCallMade('t1')).toEqual({ error: 'That brief was already handled.' })
    expect(calls.some((c) => c.table === 'prospect_touches')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('says so when the brief closed but the account could not be updated', async () => {
    called('queued', { 'prospect_touches:insert': [{ error: { message: 'boom' } }] })
    expect(await markCallMade('t1')).toEqual({ error: 'Marked as called, but the account could not be updated. Log the call on the account by hand.' })
  })

  it('returns a generic message on a database error', async () => {
    called('queued', { 'agent_tasks:update': [{ data: null, error: { code: '42501', message: 'permission denied' } }] })
    expect(await markCallMade('t1')).toEqual({ error: 'Operation failed. Please try again.' })
  })
})

describe('markProspectReplied', () => {
  const ID = '5b0a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
  const replied = (status = 'emailed', over: Record<string, Scripted[]> = {}) => asAdmin({
    'prospect_accounts:select': [{ data: { id: ID, status }, error: null }],
    'prospect_accounts:update': [{ error: null }],
    'prospect_touches:insert':  [{ error: null }],
    'agent_tasks:update':       [{ data: [{ id: 'd1' }, { id: 'd2' }], error: null }],
    ...over,
  })

  it('moves the account, logs the reply with the note, stops in-flight drafts and audits counts only', async () => {
    const { calls } = replied('emailed')
    expect(await markProspectReplied(ID, '  sounds interesting, call Friday  ')).toEqual({ stopped: 2 })

    expect(calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload)
      .toMatchObject({ status: 'replied', last_touch_at: expect.any(String) })
    expect(calls.find((c) => c.table === 'prospect_touches')!.payload)
      .toMatchObject({ prospect_id: ID, touch_type: 'replied', note: 'sounds interesting, call Friday', actor_id: 'admin_1' })

    const audit = vi.mocked(logAuditEvent).mock.calls[0][0]
    expect(audit).toMatchObject({ action: 'platform_admin.prospect_account.reply_marked', targetId: ID, metadata: { drafts_stopped: 2, had_note: true } })
    // The prospect's own words never go in the audit row.
    expect(JSON.stringify(audit)).not.toContain('call Friday')
  })

  it('only stops email drafts that are still in flight, never a call brief or a finished one', async () => {
    const { calls } = replied()
    await markProspectReplied(ID)
    const cancel = calls.find((c) => c.table === 'agent_tasks')!
    expect(cancel.payload).toMatchObject({ status: 'cancelled', decided_by: 'admin_1', decision_note: 'The prospect replied.' })
    expect(cancel.filters).toContainEqual(['eq', ['prospect_id', ID]])
    expect(cancel.filters).toContainEqual(['eq', ['team', 'sales_ops']])
    expect(cancel.filters).toContainEqual(['eq', ['task_type', 'draft_outreach']])
    expect(cancel.filters).toContainEqual(['in', ['status', ['pending', 'needs_approval', 'approved']]])
  })

  // A reply to a call, or a second reply, must never push an account back a stage.
  it.each(['replied', 'meeting_set', 'in_trial'])('keeps the stage of an account that is already %s, and still logs the reply', async (status) => {
    const { calls } = replied(status)
    expect(await markProspectReplied(ID)).toEqual({ stopped: 2 })
    const update = calls.find((c) => c.table === 'prospect_accounts' && c.op === 'update')!.payload as Record<string, unknown>
    expect(update).not.toHaveProperty('status')
    expect(update).toHaveProperty('last_touch_at')
    expect(calls.some((c) => c.table === 'prospect_touches')).toBe(true)
  })

  it.each(['won', 'lost', 'disqualified'])('refuses a closed account (%s) and writes nothing', async (status) => {
    const { calls } = replied(status)
    expect(await markProspectReplied(ID)).toEqual({ error: 'That account is closed. Reopen it first if they have come back.' })
    expect(calls.some((c) => c.op !== 'select')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a uuid and an account that is gone', async () => {
    asAdmin({})
    expect(await markProspectReplied('nope')).toEqual({ error: 'Unknown account.' })
    replied('emailed', { 'prospect_accounts:select': [{ data: null, error: null }] })
    expect(await markProspectReplied(ID)).toEqual({ error: 'That account no longer exists.' })
  })

  it('reports zero stopped when there was nothing in flight', async () => {
    replied('emailed', { 'agent_tasks:update': [{ data: [], error: null }] })
    expect(await markProspectReplied(ID)).toEqual({ stopped: 0 })
  })

  it('truncates an over-long note and stores none for a blank one', async () => {
    const long = replied()
    await markProspectReplied(ID, 'n'.repeat(2_000))
    expect((long.calls.find((c) => c.table === 'prospect_touches')!.payload as { note: string }).note).toHaveLength(500)
    const blank = replied()
    await markProspectReplied(ID, '   ')
    expect((blank.calls.find((c) => c.table === 'prospect_touches')!.payload as { note: unknown }).note).toBeNull()
  })

  // The account is marked first so nothing new is drafted; if the drafts cannot be stopped, say so.
  it('says so when the account was marked but the queued drafts could not be stopped', async () => {
    replied('emailed', { 'agent_tasks:update': [{ data: null, error: { message: 'boom' } }] })
    expect(await markProspectReplied(ID)).toEqual({ error: 'Marked as replied, but queued drafts could not be stopped. Discard any for this account by hand.' })
    expect(logAuditEvent).toHaveBeenCalled()
  })

  it('stops before cancelling anything when the account could not be updated', async () => {
    const { calls } = replied('emailed', { 'prospect_accounts:update': [{ error: { message: 'boom' } }] })
    expect(await markProspectReplied(ID)).toEqual({ error: 'Could not record the reply. Please try again.' })
    expect(calls.some((c) => c.table === 'agent_tasks')).toBe(false)
    expect(calls.some((c) => c.table === 'prospect_touches')).toBe(false)
  })

  it('returns a generic message on a read error, not the raw one', async () => {
    replied('emailed', { 'prospect_accounts:select': [{ data: null, error: { message: 'permission denied' } }] })
    expect(await markProspectReplied(ID)).toEqual({ error: 'Operation failed. Please try again.' })
  })
})

describe('requestQueueProposal', () => {
  const settings = (leadGen: boolean, master = true) => ({
    'gtm_team_settings:select': [{ data: [
      { team: 'global', enabled: master, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
      { team: 'lead_gen', enabled: leadGen, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500 },
    ], error: null }],
  })

  it('queues one human-origin, approval-required suggestion per day and audits it', async () => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: true, id: 'task_7' })
    asAdmin(settings(true))
    expect(await requestQueueProposal()).toEqual({})
    const input = vi.mocked(enqueueTask).mock.calls[0][1]
    expect(input).toMatchObject({
      team: 'lead_gen', taskType: 'queue_candidates', origin: 'human', requiresApproval: true,
      dedupeKey: expect.stringMatching(/^lead_gen:queue_candidates:manual:\d{4}-\d{2}-\d{2}$/),
    })
    expect(input).not.toHaveProperty('prospectId')
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.gtm_queue.requested', targetId: 'task_7' }))
  })

  it.each([[false, true], [true, false]])('refuses up front when Lead Gen is %s and the master switch is %s', async (leadGen, master) => {
    asAdmin(settings(leadGen, master))
    expect(await requestQueueProposal()).toEqual({ error: 'Turn on the master switch and Lead Gen first.' })
    expect(enqueueTask).not.toHaveBeenCalled()
  })

  it.each([
    ['duplicate', 'A queue suggestion was already requested today. Check the approval inbox.'],
    ['task_cap', 'Lead Gen has reached its daily task cap.'],
    ['cost_cap', 'Lead Gen has reached its daily spend cap.'],
  ] as const)('says why the queue refused (%s), and audits nothing', async (reason, message) => {
    vi.mocked(enqueueTask).mockResolvedValue({ ok: false, reason })
    asAdmin(settings(true))
    expect(await requestQueueProposal()).toEqual({ error: message })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('returns a generic message on a failure, not the raw one', async () => {
    vi.mocked(enqueueTask).mockRejectedValue(new Error('db down'))
    asAdmin(settings(true))
    expect(await requestQueueProposal()).toEqual({ error: 'Could not request the suggestion. Please try again.' })
  })
})
