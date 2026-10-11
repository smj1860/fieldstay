import { describe, it, expect } from 'vitest'
import {
  workflowStage,
  workflowStageLabel,
  stageNeedsPmAction,
  compareWorkflowOrder,
  groupByWorkflowStage,
  WORKFLOW_STAGES,
  type SortableWorkOrder,
} from '@/lib/work-orders/workflow-stage'

function wo(overrides: Partial<SortableWorkOrder> = {}): SortableWorkOrder {
  return {
    id: 'wo_1', status: 'assigned', vendor_id: 'vend_1', priority: 'medium',
    created_at: '2026-10-01T00:00:00Z', ...overrides,
  }
}

describe('workflowStage', () => {
  it('puts a submitted quote above every other reading of the row', () => {
    // The work order is nominally quote_requested, assigned, or in progress —
    // none of that matters while a vendor is waiting on a yes.
    for (const status of ['pending', 'quote_requested', 'assigned', 'in_progress'] as const) {
      expect(workflowStage(wo({ status, hasQuoteAwaitingApproval: true })), status)
        .toBe('quote_approval')
    }
  })

  it('treats the two vendor-blocked states as waiting on the PM', () => {
    for (const progress of ['awaiting_access', 'hold_pm_approval'] as const) {
      expect(workflowStage(wo({ vendor_progress: progress })), progress).toBe('vendor_blocked')
    }
  })

  it('counts a crew-assigned work order as assigned, not unassigned', () => {
    // Judging by vendor_id alone would park every crew work order in
    // "unassigned" forever: it has no vendor and never will.
    expect(workflowStage(wo({ vendor_id: null, assigned_crew_member_id: 'crew_1' })))
      .not.toBe('unassigned')
    expect(workflowStage(wo({ vendor_id: null, assigned_crew_member_id: null, status: 'pending' })))
      .toBe('unassigned')
  })

  it('separates an RFQ with no quote back from one awaiting approval', () => {
    expect(workflowStage(wo({ status: 'quote_requested', vendor_id: null }))).toBe('awaiting_quote')
    expect(workflowStage(wo({ status: 'quote_requested', hasQuoteAwaitingApproval: true })))
      .toBe('quote_approval')
  })

  it('distinguishes dispatched-and-silent from scheduled and in flight', () => {
    expect(workflowStage(wo({ vendor_progress: null }))).toBe('dispatched')
    expect(workflowStage(wo({ vendor_progress: 'appointment_scheduled' }))).toBe('scheduled')
    for (const progress of ['on_the_way', 'tech_on_site', 'parts_ordered', 'repair_in_progress'] as const) {
      expect(workflowStage(wo({ vendor_progress: progress })), progress).toBe('in_progress')
    }
  })

  it('reads a PM-set appointment with no vendor response as scheduled', () => {
    // A date a PM entered by hand is still a commitment, so it is not silence.
    expect(workflowStage(wo({ vendor_progress: null, vendor_scheduled_at: '2026-10-15T14:00:00Z' })))
      .toBe('scheduled')
  })

  it('closes out completed and cancelled before anything else', () => {
    // Including over a stale submitted quote: a closed work order is not
    // waiting on an approval, whatever quote_requests still says.
    expect(workflowStage(wo({ status: 'completed', hasQuoteAwaitingApproval: true }))).toBe('closing')
    expect(workflowStage(wo({ status: 'cancelled' }))).toBe('closing')
  })

  it('defaults the quote signal to false rather than requiring it', () => {
    // The offline Dexie cache has no quote rows. A missing signal must mean
    // "not hoisted", not a crash in the only view a PM has while offline.
    expect(workflowStage({ status: 'assigned', vendor_id: 'v' })).toBe('dispatched')
  })

  it('labels every stage, em-dash free', () => {
    for (const stage of WORKFLOW_STAGES) {
      const label = workflowStageLabel(stage)
      expect(label, stage).toBeTruthy()
      expect(label, stage).not.toMatch(/—|&mdash;|&#8212;|&#x2014;/)
    }
  })

  it('marks exactly the PM-blocking tier as needing action', () => {
    expect(WORKFLOW_STAGES.filter(stageNeedsPmAction))
      .toEqual(['quote_approval', 'vendor_blocked', 'unassigned'])
  })
})

describe('compareWorkflowOrder', () => {
  it('sorts quote approval ahead of everything, regardless of priority', () => {
    // A low-priority work order whose quote is waiting still outranks an urgent
    // one that is merely in progress: the PM is the blocker on the first.
    const quote  = wo({ id: 'a', priority: 'low',    hasQuoteAwaitingApproval: true })
    const urgent = wo({ id: 'b', priority: 'urgent', vendor_progress: 'repair_in_progress' })
    expect([urgent, quote].sort(compareWorkflowOrder).map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('falls back to priority within a stage', () => {
    const low    = wo({ id: 'low',    priority: 'low' })
    const urgent = wo({ id: 'urgent', priority: 'urgent' })
    const high   = wo({ id: 'high',   priority: 'high' })
    expect([low, urgent, high].sort(compareWorkflowOrder).map((w) => w.id))
      .toEqual(['urgent', 'high', 'low'])
  })

  it('then by nearest deadline, with undated LAST', () => {
    // "No deadline" is not the most urgent thing on the list, which is what
    // sorting null first would assert.
    const soon  = wo({ id: 'soon',  needed_by_date: '2026-10-12' })
    const later = wo({ id: 'later', needed_by_date: '2026-11-30' })
    const none  = wo({ id: 'none',  needed_by_date: null })
    expect([none, later, soon].sort(compareWorkflowOrder).map((w) => w.id))
      .toEqual(['soon', 'later', 'none'])
  })

  it('is total, so equal rows cannot swap between renders', () => {
    // created_at is not unique here: a cron that opens one work order per due
    // schedule writes a whole batch inside the same millisecond.
    const a = wo({ id: 'aaa', created_at: '2026-10-01T00:00:00Z' })
    const b = wo({ id: 'bbb', created_at: '2026-10-01T00:00:00Z' })
    expect(compareWorkflowOrder(a, b)).toBeLessThan(0)
    expect(compareWorkflowOrder(b, a)).toBeGreaterThan(0)
    expect(compareWorkflowOrder(a, a)).toBe(0)
  })

  it('keeps newest-first among otherwise equal work', () => {
    const older = wo({ id: 'older', created_at: '2026-09-01T00:00:00Z' })
    const newer = wo({ id: 'newer', created_at: '2026-10-01T00:00:00Z' })
    expect([older, newer].sort(compareWorkflowOrder).map((w) => w.id)).toEqual(['newer', 'older'])
  })
})

describe('groupByWorkflowStage', () => {
  it('returns stages in ladder order with quote approval first', () => {
    const groups = groupByWorkflowStage([
      wo({ id: 'running',  vendor_progress: 'repair_in_progress' }),
      wo({ id: 'open',     status: 'pending', vendor_id: null }),
      wo({ id: 'quote',    hasQuoteAwaitingApproval: true }),
      wo({ id: 'blocked',  vendor_progress: 'awaiting_access' }),
    ])

    expect(groups.map((g) => g.stage))
      .toEqual(['quote_approval', 'vendor_blocked', 'unassigned', 'in_progress'])
    expect(groups[0]!.workOrders.map((w) => w.id)).toEqual(['quote'])
  })

  it('drops empty stages entirely', () => {
    // So nobody scans past an empty "Quote needs your approval" band to reach
    // their actual work.
    const groups = groupByWorkflowStage([wo({ id: 'only', vendor_progress: 'tech_on_site' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.stage).toBe('in_progress')
  })

  it('sorts within each stage', () => {
    const groups = groupByWorkflowStage([
      wo({ id: 'low',    priority: 'low',    hasQuoteAwaitingApproval: true }),
      wo({ id: 'urgent', priority: 'urgent', hasQuoteAwaitingApproval: true }),
    ])
    expect(groups[0]!.workOrders.map((w) => w.id)).toEqual(['urgent', 'low'])
  })

  it('does not mutate its input', () => {
    const input = [
      wo({ id: 'b', priority: 'low' }),
      wo({ id: 'a', priority: 'urgent' }),
    ]
    const order = input.map((w) => w.id)
    groupByWorkflowStage(input)
    expect(input.map((w) => w.id)).toEqual(order)
  })

  it('handles an empty list', () => {
    expect(groupByWorkflowStage([])).toEqual([])
  })
})
