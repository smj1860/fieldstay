import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { FunnelSnapshot, KpiRow, QueueMatrix, RecentTasks } from '@/app/admin/prospects/agents/agents-panels'
import { buildMetrics } from '@/lib/gtm/manager/brief'
import { parseRollup } from '@/lib/gtm/rollup'
import type { RecentTask } from '@/lib/gtm/dashboard'
import type { TeamSetting } from '@/lib/gtm/policy'

// ============================================================================
// The read-only half of the Agents view. These are Server Components in the
// app, but they are plain functions of already-computed numbers, so they render
// here. What matters is that every number reaches the right label and that an
// empty system reads as empty rather than broken.
// ============================================================================

const NOW = new Date('2026-11-18T12:00:00Z')
const settings: TeamSetting[] = (['global', 'manager', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'] as const).map((team) => ({
  team, enabled: false, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500,
}))
const rollup = parseRollup({
  funnel:  { new: 100, replied: 5, meeting_set: 2, in_trial: 1, won: 3, lost: 10 },
  touches: { emailed: 40, replied: 8 },
  tasks:   [{ team: 'lead_gen', status: 'needs_approval', count: 4 }, { team: 'rev_ops', status: 'done', count: 7 }],
  spend:   [{ team: 'lead_gen', cost_cents: 125, calls: 3 }],
})
const metrics = buildMetrics(rollup, settings, NOW)

describe('KpiRow', () => {
  it('labels each headline number', () => {
    render(<KpiRow metrics={metrics} />)
    const accounts = screen.getByText('Accounts').closest('div')!
    expect(within(accounts).getByText('121')).toBeInTheDocument()
    expect(within(screen.getByText('Meetings').closest('div')!).getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/8 replies from 40 emails/)).toBeInTheDocument()
  })

  it('does not invent a reply rate when nothing was emailed', () => {
    render(<KpiRow metrics={buildMetrics(parseRollup({}), settings, NOW)} />)
    expect(screen.getByText('No emails in the last 7 days')).toBeInTheDocument()
  })
})

describe('FunnelSnapshot', () => {
  it('lists every stage in funnel order, including the empty ones', () => {
    render(<FunnelSnapshot funnel={rollup.funnel} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(14)
    expect(within(rows[0]).getByText('New')).toBeInTheDocument()
    expect(within(rows[0]).getByText('100')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Researching')).toBeInTheDocument()
    expect(within(rows[1]).getByText('0')).toBeInTheDocument()
  })

  it('draws the bars for sighted users only, so a screen reader reads the numbers', () => {
    const { container } = render(<FunnelSnapshot funnel={{}} />)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(14)
  })
})

describe('QueueMatrix', () => {
  it('puts each count under its team and status, and spend against the cap', () => {
    render(<QueueMatrix rollup={rollup} metrics={metrics} />)
    const lead = screen.getByRole('rowheader', { name: 'Lead Gen' }).closest('tr')!
    expect(within(lead).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0', '0', '4', '0', '0', '0', '$1.25 of $5.00'])
    const rev = screen.getByRole('rowheader', { name: 'Rev Ops' }).closest('tr')!
    expect(within(rev).getAllByRole('cell')[4]).toHaveTextContent('7')
  })

  it('uses real column headers', () => {
    render(<QueueMatrix rollup={rollup} metrics={metrics} />)
    expect(screen.getByRole('columnheader', { name: 'Needs approval' })).toBeInTheDocument()
  })
})

describe('RecentTasks', () => {
  const task = (over: Partial<RecentTask> = {}): RecentTask => ({
    id: 't1', team: 'lead_gen', taskType: 'enrich_account', status: 'failed', company: 'Acme Rentals',
    error: 'Stalled: claimed but never finished', updatedAt: '2026-11-18T09:00:00Z', ...over,
  })

  it('shows what happened, to whom, and why it failed', () => {
    render(<RecentTasks tasks={[task()]} now={NOW} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('enrich account')).toBeInTheDocument()
    expect(screen.getByText('Acme Rentals')).toBeInTheDocument()
    expect(screen.getByText('Stalled: claimed but never finished')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toBeInTheDocument()
  })

  it('tells a new install that nothing has happened yet, instead of rendering an empty box', () => {
    render(<RecentTasks tasks={[]} now={NOW} />)
    expect(screen.getByText(/No agent has done anything yet/)).toBeInTheDocument()
  })
})
