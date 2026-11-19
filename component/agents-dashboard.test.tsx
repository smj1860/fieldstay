import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const decideAgentTask = vi.fn()
const updateTeamSettings = vi.fn()
const requestManagerRun = vi.fn()
const requestRevOpsReport = vi.fn()
const markDraftSent = vi.fn()
vi.mock('@/app/admin/prospects/agents-actions', () => ({
  decideAgentTask:    (...a: unknown[]) => decideAgentTask(...a),
  updateTeamSettings: (...a: unknown[]) => updateTeamSettings(...a),
  requestManagerRun:  () => requestManagerRun(),
  requestRevOpsReport: () => requestRevOpsReport(),
  markDraftSent:      (...a: unknown[]) => markDraftSent(...a),
}))

import { ApprovalInbox } from '@/app/admin/prospects/agents/approval-inbox'
import { MasterSwitch, TeamCard } from '@/app/admin/prospects/agents/team-controls'
import { ManagerPanel } from '@/app/admin/prospects/agents/manager-panel'
import { ReadyToSend } from '@/app/admin/prospects/agents/ready-to-send'
import type { ApprovalItem, DecisionItem, ReadyDraft } from '@/lib/gtm/dashboard'
import type { TeamSetting } from '@/lib/gtm/policy'

// ============================================================================
// The Agents view is where a person decides what leaves the company and whether
// an agent runs at all. These pin the controls that matter: an approval sends
// the right decision for the right item, a refusal is shown rather than lost,
// and the switches send exactly what their label says.
// ============================================================================

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 't1', team: 'sales_ops', taskType: 'follow_up_email', company: 'Acme Rentals',
  output: { subject: 'Quick question', body: 'Hi Dana' }, createdAt: '2026-11-18T10:00:00Z', ...over,
})
const setting = (over: Partial<TeamSetting> = {}): TeamSetting => ({
  team: 'lead_gen', enabled: false, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  decideAgentTask.mockResolvedValue({})
  updateTeamSettings.mockResolvedValue({})
  requestManagerRun.mockResolvedValue({})
  requestRevOpsReport.mockResolvedValue({})
  markDraftSent.mockResolvedValue({})
})

describe('ApprovalInbox', () => {
  it('shows the draft a person is about to approve, with the account and how long it has waited', () => {
    render(<ApprovalInbox items={[item()]} totalWaiting={1} ages={{ t1: '3h ago' }} />)
    expect(screen.getByText(/Acme Rentals/)).toBeInTheDocument()
    expect(screen.getByText(/Hi Dana/)).toBeInTheDocument()
    expect(screen.getByText(/waiting 3h ago/)).toBeInTheDocument()
  })

  it('approves THIS item with the note that was typed, then refreshes', async () => {
    render(<ApprovalInbox items={[item()]} totalWaiting={1} ages={{ t1: '3h ago' }} />)
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'fine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(decideAgentTask).toHaveBeenCalledWith('t1', 'approve', 'fine'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('rejects with a reject, not an approve', async () => {
    render(<ApprovalInbox items={[item()]} totalWaiting={1} ages={{ t1: '1h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(decideAgentTask).toHaveBeenCalledWith('t1', 'reject', ''))
  })

  // Two admins can open the same draft; the loser must be told, not left guessing.
  it('shows a refusal instead of swallowing it, and does not refresh as if it worked', async () => {
    decideAgentTask.mockResolvedValue({ error: 'That item was already handled.' })
    render(<ApprovalInbox items={[item()]} totalWaiting={1} ages={{ t1: '1h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That item was already handled.')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('says nothing is waiting when the inbox is empty', () => {
    render(<ApprovalInbox items={[]} totalWaiting={0} ages={{}} />)
    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument()
  })

  it('admits when more are waiting than are shown, rather than implying the list is complete', () => {
    render(<ApprovalInbox items={[item()]} totalWaiting={9} ages={{ t1: '1h ago' }} />)
    expect(screen.getByText(/8 more waiting/)).toBeInTheDocument()
  })
})

describe('MasterSwitch', () => {
  it('pauses everything with one click when agents are on', async () => {
    render(<MasterSwitch setting={setting({ team: 'global', enabled: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause all agents' }))
    await waitFor(() => expect(updateTeamSettings).toHaveBeenCalledWith('global', { enabled: false }))
  })

  it('offers to resume when paused, and says so', () => {
    render(<MasterSwitch setting={setting({ team: 'global', enabled: false })} />)
    expect(screen.getByText('All agents paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume agents' })).toBeInTheDocument()
  })
})

describe('TeamCard', () => {
  it('turns a team on, sending only the flag', async () => {
    render(<TeamCard setting={setting()} masterOn />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(updateTeamSettings).toHaveBeenCalledWith('lead_gen', { enabled: true }))
  })

  // The honest status: an enabled team under a paused master is not running.
  it('says a team is held when the master switch is off, rather than calling it running', () => {
    render(<TeamCard setting={setting({ enabled: true })} masterOn={false} />)
    expect(screen.getByText('Held by master switch')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('only offers Save once a limit has changed, and sends dollars as whole cents', async () => {
    render(<TeamCard setting={setting()} masterOn />)
    expect(screen.queryByRole('button', { name: 'Save limits' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Spend per day ($)'), { target: { value: '7.25' } })
    fireEvent.change(screen.getByLabelText('Tasks per day'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }))

    await waitFor(() => expect(updateTeamSettings).toHaveBeenCalledWith('lead_gen', { daily_task_cap: 12, daily_cost_cap_cents: 725 }))
  })

  it('does not send a blank or nonsense limit', () => {
    render(<TeamCard setting={setting()} masterOn />)
    fireEvent.change(screen.getByLabelText('Spend per day ($)'), { target: { value: 'lots' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a task count and a dollar amount.')
    expect(updateTeamSettings).not.toHaveBeenCalled()
  })

  it('shows a server refusal inline', async () => {
    updateTeamSettings.mockResolvedValue({ error: 'Daily task cap must be a whole number from 0 to 10000.' })
    render(<TeamCard setting={setting()} masterOn />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Daily task cap')
  })

  it('locks the manager to observe-only and says why', () => {
    render(<TeamCard setting={setting({ team: 'manager' })} masterOn />)
    expect(screen.getByLabelText('Autonomy')).toBeDisabled()
    expect(screen.getByText(/Observe-only for now/)).toBeInTheDocument()
  })
})

describe('Rev Ops "Run report now"', () => {
  it('is offered only on the Rev Ops card', () => {
    render(<TeamCard setting={setting({ team: 'lead_gen' })} masterOn />)
    expect(screen.queryByRole('button', { name: 'Run report now' })).not.toBeInTheDocument()
  })

  // A button that looks like it worked when the queue would refuse the task is worse than no button.
  it('is disabled while Rev Ops is off or the master switch is', () => {
    const { unmount } = render(<TeamCard setting={setting({ team: 'rev_ops', enabled: false })} masterOn />)
    expect(screen.getByRole('button', { name: 'Run report now' })).toBeDisabled()
    unmount()
    render(<TeamCard setting={setting({ team: 'rev_ops', enabled: true })} masterOn={false} />)
    expect(screen.getByRole('button', { name: 'Run report now' })).toBeDisabled()
  })

  it('requests a report and says where it will appear', async () => {
    render(<TeamCard setting={setting({ team: 'rev_ops', enabled: true })} masterOn />)
    fireEvent.click(screen.getByRole('button', { name: 'Run report now' }))
    expect(await screen.findByRole('status')).toHaveTextContent('approval inbox')
    expect(requestRevOpsReport).toHaveBeenCalledTimes(1)
  })

  it('shows the server\'s refusal instead of pretending it started', async () => {
    requestRevOpsReport.mockResolvedValue({ error: 'Turn on the master switch and Rev Ops first.' })
    render(<TeamCard setting={setting({ team: 'rev_ops', enabled: true })} masterOn />)
    fireEvent.click(screen.getByRole('button', { name: 'Run report now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn on the master switch')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('ManagerPanel', () => {
  const decision = (over: Partial<DecisionItem> = {}): DecisionItem => ({
    id: 'd1', kind: 'morning_plan', brief: 'Morning plan, 2026-11-18\n\nPipeline: 10 accounts.', model: null,
    autonomyAtRun: 'propose_only', createdAt: '2026-11-18T12:00:00Z', ...over,
  })

  it('shows the latest brief as written', () => {
    render(<ManagerPanel latest={decision()} history={[decision()]} ages={{ d1: '2h ago' }} />)
    expect(screen.getByText(/Pipeline: 10 accounts\./)).toBeInTheDocument()
    expect(screen.getByText(/Morning plan, 2h ago/)).toBeInTheDocument()
  })

  it('explains what to do when the manager has not run yet', () => {
    render(<ManagerPanel latest={null} history={[]} ages={{}} />)
    expect(screen.getByText(/No brief yet/)).toBeInTheDocument()
  })

  it('requests a run and tells the person the brief is on its way', async () => {
    render(<ManagerPanel latest={null} history={[]} ages={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run manager now' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Requested.')
    expect(requestManagerRun).toHaveBeenCalledTimes(1)
  })

  it('shows a failure to request instead of pretending it started', async () => {
    requestManagerRun.mockResolvedValue({ error: 'Could not start the manager. Please try again.' })
    render(<ManagerPanel latest={null} history={[]} ages={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run manager now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the manager')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('tucks earlier briefs away rather than stacking them', () => {
    render(<ManagerPanel latest={decision()} history={[decision(), decision({ id: 'd0', brief: 'Older brief' })]} ages={{ d1: '2h ago', d0: '1d ago' }} />)
    expect(screen.getByText('Earlier briefs (1)')).toBeInTheDocument()
  })
})

describe('ReadyToSend', () => {
  const draft = (over: Partial<ReadyDraft> = {}): ReadyDraft => ({
    id: 'd1', company: 'Acme Rentals', contactName: 'Dana Smith', email: 'dana@acmerentals.com',
    subject: 'Turnovers on Lake Martin', body: 'Hi Dana, text of the email', approvedAt: '2026-11-18T10:00:00Z', ...over,
  })
  const writeText = vi.fn()

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  it('shows the recipient, the subject and the body, and says FieldStay does not send', () => {
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    expect(screen.getByText('Acme Rentals')).toBeInTheDocument()
    expect(screen.getByText('dana@acmerentals.com')).toBeInTheDocument()
    expect(screen.getByText('Turnovers on Lake Martin')).toBeInTheDocument()
    expect(screen.getByText(/Hi Dana, text of the email/)).toBeInTheDocument()
    expect(screen.getByText(/FieldStay does not send email/)).toBeInTheDocument()
  })

  it.each([
    ['Copy address', 'dana@acmerentals.com'],
    ['Copy subject', 'Turnovers on Lake Martin'],
    ['Copy body', 'Hi Dana, text of the email'],
  ])('%s copies exactly that text', async (label, expected) => {
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
  })

  it('says so, and offers the manual route, when the clipboard is not available', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy body' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('copy it by hand')
  })

  it('records the send for THIS draft, then refreshes', async () => {
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'I sent this' }))
    await waitFor(() => expect(markDraftSent).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('discards a draft with a cancel, not a send', async () => {
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(decideAgentTask).toHaveBeenCalledWith('d1', 'cancel'))
    expect(markDraftSent).not.toHaveBeenCalled()
  })

  it('shows a refusal instead of swallowing it, and does not refresh as if it worked', async () => {
    markDraftSent.mockResolvedValue({ error: 'That draft was already handled.' })
    render(<ReadyToSend drafts={[draft()]} ages={{ d1: '2h ago' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'I sent this' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already handled')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('offers no address button when the account has no email, and still works', () => {
    render(<ReadyToSend drafts={[draft({ email: null })]} ages={{ d1: '2h ago' }} />)
    expect(screen.queryByRole('button', { name: 'Copy address' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy body' })).toBeInTheDocument()
  })

  it('says nothing is waiting when there are no approved drafts', () => {
    render(<ReadyToSend drafts={[]} ages={{}} />)
    expect(screen.getByText('No approved drafts are waiting.')).toBeInTheDocument()
  })
})
