import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const decideAgentTask = vi.fn()
const updateTeamSettings = vi.fn()
const requestManagerRun = vi.fn()
vi.mock('@/app/admin/prospects/agents-actions', () => ({
  decideAgentTask:    (...a: unknown[]) => decideAgentTask(...a),
  updateTeamSettings: (...a: unknown[]) => updateTeamSettings(...a),
  requestManagerRun:  () => requestManagerRun(),
}))

import { ApprovalInbox } from '@/app/admin/prospects/agents/approval-inbox'
import { MasterSwitch, TeamCard } from '@/app/admin/prospects/agents/team-controls'
import { ManagerPanel } from '@/app/admin/prospects/agents/manager-panel'
import type { ApprovalItem, DecisionItem } from '@/lib/gtm/dashboard'
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
